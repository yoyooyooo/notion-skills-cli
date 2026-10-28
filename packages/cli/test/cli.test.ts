import { beforeAll, expect, test } from "bun:test"
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readlink,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const main = new URL("../dist/ntn-skills.js", import.meta.url).pathname
beforeAll(async () => {
  const build = Bun.spawn(["bun", "run", "build"], {
    cwd: new URL("../../../", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
    build.exited,
  ])
  if (exit !== 0) throw new Error(`Fresh production CLI build failed: ${stdout}\n${stderr}`)
})
const node = (() => {
  const executable = Bun.which("node")
  if (!executable) throw new Error("Node.js is required for the production CLI consumer tests.")
  // Resolve version-manager shims before invoke() isolates HOME.
  const resolved = Bun.spawnSync([executable, "--print", "process.execPath"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (resolved.exitCode !== 0)
    throw new Error(`Could not resolve the Node.js executable: ${resolved.stderr.toString()}`)
  return resolved.stdout.toString().trim()
})()
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
  options: {
    inaccessible?: boolean
    traceOnline?: boolean
    root?: string
    runtime?: string
    entrypoint?: string
  } = {},
) {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), "ntn-skills-cli-test-")))
  const marker = join(root, "online-called")
  const provider = join(root, "ntn-probe")
  if (options.traceOnline) {
    await writeFile(provider, `#!/bin/sh\nprintf called >> '${marker}'\nexit 97\n`)
    await chmod(provider, 0o700)
  }
  const selectedRoot = options.inaccessible ? "/nonexistent/ntn-skills-cli-help" : root
  const child = Bun.spawn([options.runtime ?? node, options.entrypoint ?? main, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: {
      ...process.env,
      NOTION_API_TOKEN: "",
      NOTION_WORKSPACE_ID: "",
      NOTION_API_BASE_URL: "",
      HOME: join(root, "home"),
      NTN_SKILLS_DATA_HOME: "",
      XDG_DATA_HOME: join(root, "xdg-data"),
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
  // Runtime diagnostics may use stderr; command errors remain one JSON value on stdout.
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

test("retired root commands and name-based replacement are rejected offline", async () => {
  for (const args of [
    ["open", "sample"],
    ["import", "missing.md"],
    ["builtin", "list"],
    ["config", "show"],
    ["cache", "status"],
    ["database", "list"],
    ["source", "list"],
    ["doctor"],
    ["resume", "operation-id"],
    ["sync", "status"],
    ["sync", "reconcile", "binding"],
    ["replace", "missing.md"],
    ["replace", "missing.md", "--target", "Sample Skill"],
  ])
    await invalid(args)
}, 60000)

test("read schema exposes official parameter types and requiredness offline", async () => {
  const result = await invoke(["schema", "read"], { inaccessible: true, traceOnline: true })
  expect(result.exit).toBe(0)
  expect(result.stderr).toBe("")
  expect(result.onlineCalled).toBe(false)
  const output = JSON.parse(result.stdout)
  expect(output).toMatchObject({
    ok: true,
    format: "effect-cli-schema",
    version: 1,
    command: ["read"],
  })
  expect(output.schema.parameters).toContainEqual(
    expect.objectContaining({
      name: "target",
      kind: "argument",
      type: "string",
      required: true,
      min_occurrences: 1,
      max_occurrences: 1,
    }),
  )
  expect(output.schema.parameters).toContainEqual(
    expect.objectContaining({
      name: "offline",
      kind: "flag",
      type: "boolean",
      required: false,
      min_occurrences: 0,
      max_occurrences: 1,
      default: false,
    }),
  )
  expect(output.schema.args).toBeUndefined()
  expect(output.schema.flags).toBeUndefined()
  expect(Array.isArray(output.schema.commands)).toBe(true)
}, 15000)

test("database init schema exposes exact table attachment and durable resume offline", async () => {
  const result = await invoke(["schema", "ctl", "database", "init"], {
    inaccessible: true,
    traceOnline: true,
  })
  expect(result.exit).toBe(0)
  expect(result.onlineCalled).toBe(false)
  const output = JSON.parse(result.stdout)
  expect(output.command).toEqual(["ctl", "database", "init"])
  for (const name of [
    "parent",
    "content-database",
    "upstream-database",
    "operation",
    "set-default",
  ])
    expect(output.schema.parameters).toContainEqual(
      expect.objectContaining({ name, kind: "flag", required: false }),
    )
})

test("operation resume schema exposes explicit new artifact opt-in offline", async () => {
  const result = await invoke(["schema", "operation", "resume"], {
    inaccessible: true,
    traceOnline: true,
  })
  expect(result.exit).toBe(0)
  expect(result.onlineCalled).toBe(false)
  expect(JSON.parse(result.stdout).schema.parameters).toContainEqual(
    expect.objectContaining({
      name: "new-artifact",
      kind: "flag",
      type: "boolean",
      required: false,
      min_occurrences: 0,
      max_occurrences: 1,
      default: false,
    }),
  )
})

test("upstream schema projects its official parameters and exclusive selection offline", async () => {
  for (const [leaf, required] of [
    ["add", ["input", "operation"]],
    ["update", ["subscription-id", "input", "if-version"]],
    ["remove", ["subscription-id", "if-version"]],
  ] as const) {
    const result = await invoke(["schema", "sync", "upstream", leaf], {
      inaccessible: true,
      traceOnline: true,
    })
    expect(result.exit).toBe(0)
    expect(result.onlineCalled).toBe(false)
    const parameters = JSON.parse(result.stdout).schema.parameters
    for (const name of required)
      expect(parameters).toContainEqual(
        expect.objectContaining({ name, required: true, min_occurrences: 1, max_occurrences: 1 }),
      )
  }
  const result = await invoke(["schema", "sync", "upstream", "run"], {
    inaccessible: true,
    traceOnline: true,
  })
  expect(result.exit).toBe(0)
  expect(result.onlineCalled).toBe(false)
  const schema = JSON.parse(result.stdout).schema
  expect(schema.parameters).toContainEqual(
    expect.objectContaining({
      name: "target",
      kind: "flag",
      min_occurrences: 0,
      max_occurrences: null,
    }),
  )
  expect(schema.parameters).toContainEqual(
    expect.objectContaining({
      name: "all",
      kind: "flag",
      min_occurrences: 0,
      max_occurrences: 1,
      default: false,
    }),
  )
  expect(schema.constraints).toContainEqual({ kind: "exactly_one", flags: ["target", "all"] })
  for (const args of [
    ["sync", "upstream", "run"],
    ["sync", "upstream", "run", "--target", "11111111-1111-4111-8111-111111111111", "--all"],
    ["sync", "upstream", "run", "--all", "--all"],
    ["sync", "upstream", "add", "--input", "missing.json"],
    [
      "sync",
      "upstream",
      "update",
      "11111111-1111-4111-8111-111111111111",
      "--input",
      "missing.json",
    ],
  ])
    await invalid(args)
}, 60000)

test("sync exposes local and upstream paths without a root upstream alias", async () => {
  for (const path of [
    ["sync", "local"],
    ["sync", "upstream"],
  ]) {
    const result = await invoke(["schema", ...path], { inaccessible: true, traceOnline: true })
    expect(result.exit).toBe(0)
    expect(result.onlineCalled).toBe(false)
    expect(JSON.parse(result.stdout).command).toEqual(path)
  }
  for (const args of [
    ["schema", "upstream"],
    ["upstream", "run", "--all"],
  ]) {
    const result = await invoke(args, { inaccessible: true, traceOnline: true })
    expect(result.exit).not.toBe(0)
    expect(result.onlineCalled).toBe(false)
  }
}, 30000)

test("export projection schema defaults to source and rejects unsupported or repeated values offline", async () => {
  const result = await invoke(["schema", "export"], { inaccessible: true, traceOnline: true })
  expect(result.exit).toBe(0)
  expect(result.onlineCalled).toBe(false)
  const schema = JSON.parse(result.stdout).schema
  expect(schema.parameters).toContainEqual(
    expect.objectContaining({
      name: "projection",
      kind: "flag",
      type: "string",
      required: false,
      min_occurrences: 0,
      max_occurrences: 1,
      default: "source",
    }),
  )
  expect(schema.constraints).toContainEqual({
    kind: "allowed_values",
    flag: "projection",
    values: ["source", "snapshot"],
  })
  await invalid(["export", "sample", "--output", "out", "--projection", "other"])
  await invalid([
    "export",
    "sample",
    "--output",
    "out",
    "--projection",
    "source",
    "--projection",
    "snapshot",
  ])
}, 30000)

test("Router member flags expose repeatable exact selection and exclusive clearing offline", async () => {
  const target = "11111111-1111-4111-8111-111111111111"
  for (const command of ["create", "replace", "update"]) {
    const result = await invoke(["schema", command], { inaccessible: true, traceOnline: true })
    expect(result.exit).toBe(0)
    expect(result.onlineCalled).toBe(false)
    const schema = JSON.parse(result.stdout).schema
    expect(schema.parameters).toContainEqual(
      expect.objectContaining({
        name: "description",
        description: expect.stringContaining("2000 Unicode characters"),
      }),
    )
    expect(schema.parameters).toContainEqual(
      expect.objectContaining({
        name: "member",
        kind: "flag",
        type: "string",
        required: false,
        min_occurrences: 0,
        max_occurrences: null,
        default: [],
      }),
    )
    expect(schema.parameters).toContainEqual(
      expect.objectContaining({
        name: "clear-members",
        kind: "flag",
        type: "boolean",
        required: false,
        min_occurrences: 0,
        max_occurrences: 1,
        default: false,
      }),
    )
    expect(schema.constraints).toContainEqual({
      kind: "mutually_exclusive",
      flags: ["member", "clear-members"],
    })
    const args =
      command === "replace"
        ? [command, "missing.md", "--target", target]
        : [command, command === "create" ? "missing.md" : target]
    await invalid([...args, "--member", target, "--clear-members"])
    await invalid([...args, "--clear-members", "--clear-members"])
  }
}, 60000)

test("machine constraints and handler rejection share the command contract", async () => {
  for (const [path, expected] of [
    [["read"], { kind: "mutually_exclusive", flags: ["raw", "output"] }],
    [["sync", "local", "plan"], { kind: "exactly_one", flags: ["binding", "all"] }],
    [["ctl", "cache", "clear"], { kind: "requires_absent", flag: "all", absent: ["database"] }],
  ] as const) {
    const result = await invoke(["schema", ...path], { inaccessible: true, traceOnline: true })
    expect(result.exit).toBe(0)
    expect(result.onlineCalled).toBe(false)
    expect(JSON.parse(result.stdout).schema.constraints).toContainEqual(expected)
  }
  for (const args of [
    ["read", "sample", "--raw", "--output", "out.md"],
    ["read", "sample", "--lines", "1-2", "--output", "out.md"],
    ["sync", "local", "plan"],
    ["sync", "local", "plan", "binding", "--all"],
    ["sync", "local", "plan", "--all", "--from", "local"],
    ["ctl", "cache", "clear", "--all", "--database", "db"],
  ])
    await invalid(args)
}, 60000)

test("update Default Context accepts explicit true and false and rejects repetition", async () => {
  const target = "11111111-1111-4111-8111-111111111111"
  for (const flags of [
    ["--default-context"],
    ["--default-context=true"],
    ["--default-context=false"],
  ]) {
    const result = await invoke(["update", target, ...flags, "--dry-run"])
    jsonFailure(result, "NTN_UNAVAILABLE", 1)
  }
  await invalid(["update", target, "--default-context", "--default-context"])
  await invalid(["update", target, "--default-context=true", "--default-context=false"])
}, 30000)

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
    ["replace", "missing.md", "--target", "11111111-1111-4111-8111-111111111111", "--refresh"],
    ["ctl", "doctor", "--max-age", "0"],
    [
      "replace",
      "missing.md",
      "--target",
      `skill://sample/references/guide.md?snapshot=${snapshot}`,
    ],
  ])
    await invalid(args)
}, 60000)

test("name reads, refresh policies and valid duration overrides reach online validation", async () => {
  for (const command of [
    ["list"],
    ["read", "Sample Skill"],
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
    ["files", snapshot],
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
    ["sync", "local", "bind", "sample"],
    ["sync", "local", "bind", pinned, "--path", "local"],
    ["sync", "local", "plan"],
    ["sync", "local", "plan", "binding", "--all"],
    ["sync", "local", "plan", "--all", "--from", "local"],
    ["sync", "local", "plan", "--all", "--from", "notion"],
    ["sync", "local", "plan", "binding", "--from", "remote"],
    ["sync", "local", "plan", "binding", "--dry-run"],
    ["sync", "local", "apply"],
    ["sync", "local", "apply", "--plan", "p_invalid", "--all"],
    ["sync", "local", "apply", "--plan", "p_invalid", "--from", "local"],
    ["operation", "reconcile", "operation-id", "--force"],
    ["sync", "local", "status", "--offline"],
    ["sync", "local", "unbind"],
    ["ctl", "cache", "clear"],
    ["ctl", "cache", "clear", "sample", "--all"],
    ["ctl", "cache", "clear", "--all", "--database", "sample"],
    ["ctl", "cache", "clear", pinned],
    ["ctl", "config", "set-cache-policy"],
  ])
    await invalid(args)
}, 60000)

test("valid sync selections and explicit replacement targets reach their actual operational prerequisites", async () => {
  for (const args of [
    ["sync", "local", "bind", "sample", "--path", "local", "--as", "local-copy", "--dry-run"],
    [
      "sync",
      "local",
      "connect",
      "11111111-1111-4111-8111-111111111111",
      "--path",
      "local",
      "--dry-run",
    ],
    [
      "sync",
      "upstream",
      "connect",
      "https://example.com/skills.git",
      "--database",
      "11111111-1111-4111-8111-111111111111",
    ],
    ["replace", "missing.md", "--target", "11111111-1111-4111-8111-111111111111", "--dry-run"],
  ])
    jsonFailure(await invoke(args), "NTN_UNAVAILABLE", 1)
  for (const source of ["local", "notion"]) {
    const result = await invoke(
      ["sync", "local", "plan", "missing-binding", "--from", source, "--output", "plan.json"],
      { traceOnline: true },
    )
    jsonFailure(result, "SYNC_BINDING_MISSING", 1)
    expect(result.onlineCalled).toBe(false)
  }
  const empty = await invoke(["sync", "local", "status"])
  expect(empty.exit).toBe(0)
  expect(JSON.parse(empty.stdout)).toEqual({ ok: true, bindings: [] })
}, 30000)

const helpCommands = [
  [],
  ["apply"],
  ["sync", "local", "connect"],
  ["sync", "local", "run"],
  ["sync", "local", "check"],
  ["sync", "upstream"],
  ["sync", "upstream", "connect"],
  ["sync", "upstream", "run"],
  ["sync", "upstream", "list"],
  ["list"],
  ["ctl", "database"],
  ["ctl", "database", "list"],
  ["read"],
  ["files"],
  ["create"],
  ["replace"],
  ["update"],
  ["schema"],
  ["schema", "read"],
  ["ctl"],
  ["ctl", "status"],
  ["ctl", "backup"],
  ["operation"],
  ["operation", "list"],
  ["operation", "show"],
  ["sync", "local"],
  ["export"],
  ["write"],
  ["ctl", "config"],
  ["ctl", "config", "show"],
  ["ctl", "config", "set"],
  ["ctl", "config", "unset"],
  ["ctl", "config", "set-token"],
  ["ctl", "config", "clear-token"],
  ["ctl", "database"],
  ["ctl", "database", "register"],
  ["ctl", "database", "unregister"],
  ["sync"],
  ["sync", "local", "bind"],
  ["sync", "local", "status"],
  ["sync", "local", "plan"],
  ["sync", "local", "apply"],
  ["operation", "reconcile"],
  ["sync", "local", "unbind"],
  ["ctl", "cache"],
  ["ctl", "cache", "status"],
  ["ctl", "cache", "clear"],
  ["resolve"],
  ["ctl", "doctor"],
  ["operation", "resume"],
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
test("daily recovery guidance names executable command paths offline", async () => {
  for (const [path, instruction] of [
    [["create"], "operation resume OPERATION_ID"],
    [["sync", "local", "bind"], "sync local run BINDING --from local|notion"],
    [["operation"], "operation"],
  ] as const) {
    const help = await invoke([...path, "--help"], { inaccessible: true, traceOnline: true })
    expect(help.exit).toBe(0)
    expect(help.onlineCalled).toBe(false)
    expect(help.stdout.replace(/\s+/g, " ")).toContain(instruction)
    const schema = await invoke(["schema", ...path], { inaccessible: true, traceOnline: true })
    expect(schema.exit).toBe(0)
    expect(schema.onlineCalled).toBe(false)
    expect(JSON.stringify(JSON.parse(schema.stdout).schema)).toContain(instruction)
  }
}, 30000)

test("parser errors return the relevant offline help command", async () => {
  for (const [args, next] of [
    [["read"], ["ntn-skills", "read", "--help"]],
    [
      ["sync", "local", "plan", "--unknown-option"],
      ["ntn-skills", "sync", "local", "plan", "--help"],
    ],
    [["unknown-command"], ["ntn-skills", "--help"]],
  ] satisfies Array<[string[], string[]]>) {
    const failed = await invoke(args, { inaccessible: true, traceOnline: true })
    jsonFailure(failed, "INVALID_ARGUMENT")
    expect(failed.onlineCalled).toBe(false)
    expect(JSON.parse(failed.stdout).next.argv).toEqual(next)
    const help = await invoke(next.slice(1), { inaccessible: true, traceOnline: true })
    expect(help.exit).toBe(0)
    expect(help.onlineCalled).toBe(false)
  }
}, 30000)

test("apply exposes sparse changes and enforces metadata selection before access", async () => {
  const schema = await invoke(["schema", "apply"], { inaccessible: true, traceOnline: true })
  expect(schema.exit).toBe(0)
  expect(schema.onlineCalled).toBe(false)
  const output = JSON.parse(schema.stdout)
  expect(output.schema.parameters).toContainEqual(
    expect.objectContaining({ name: "target", kind: "argument", required: true }),
  )
  expect(output.schema.parameters).toContainEqual(
    expect.objectContaining({ name: "input", kind: "flag", required: false, max_occurrences: 1 }),
  )
  expect(output.schema.parameters).toContainEqual(
    expect.objectContaining({
      name: "remove",
      kind: "flag",
      min_occurrences: 0,
      max_occurrences: null,
    }),
  )
  const help = await invoke(["apply", "--help"], { inaccessible: true, traceOnline: true })
  expect(help.exit).toBe(0)
  expect(help.onlineCalled).toBe(false)
  expect(help.stdout.replace(/\s+/g, " ")).toContain("operation resume OPERATION_ID")
  const page = "11111111-1111-4111-8111-111111111111"
  for (const command of ["apply", "update"])
    await invalid([command, pinned, "--member", page, "--clear-members"])
}, 30000)

test("upstream connect exposes Git source and member directory selection offline", async () => {
  const result = await invoke(["schema", "sync", "upstream", "connect"], {
    inaccessible: true,
    traceOnline: true,
  })
  expect(result.exit).toBe(0)
  expect(result.onlineCalled).toBe(false)
  const parameters = JSON.parse(result.stdout).schema.parameters
  expect(parameters).toContainEqual(
    expect.objectContaining({
      name: "source",
      kind: "argument",
      required: true,
      max_occurrences: 1,
    }),
  )
  for (const name of ["root", "include", "exclude"])
    expect(parameters).toContainEqual(
      expect.objectContaining({ name, kind: "flag", min_occurrences: 0, max_occurrences: null }),
    )
  expect(parameters.some((parameter: { name: string }) => parameter.name === "input")).toBe(false)
  const help = await invoke(["sync", "upstream", "connect", "--help"], {
    inaccessible: true,
    traceOnline: true,
  })
  expect(help.exit).toBe(0)
  expect(help.onlineCalled).toBe(false)
  expect(help.stdout).toContain("HEAD")
  expect(help.stdout.replace(/\s+/g, " ")).toContain("member directory")
  await invalid(["sync", "upstream", "connect"])
  await invalid([
    "sync",
    "upstream",
    "connect",
    "https://example.com/skills.git",
    "--ref",
    "main",
    "--ref",
    "main",
  ])
})

test("local connect exposes one initial direction and validates it before access", async () => {
  const schema = await invoke(["schema", "sync", "local", "connect"], {
    inaccessible: true,
    traceOnline: true,
  })
  expect(schema.exit).toBe(0)
  expect(schema.onlineCalled).toBe(false)
  const contract = JSON.parse(schema.stdout).schema
  expect(
    contract.parameters.find((parameter: { name: string }) => parameter.name === "path"),
  ).toMatchObject({
    required: true,
    min_occurrences: 1,
    max_occurrences: 1,
  })
  expect(contract.constraints).toContainEqual({
    kind: "allowed_values",
    flag: "from",
    values: ["local", "notion"],
  })
  const help = await invoke(["sync", "local", "connect", "--help"], {
    inaccessible: true,
    traceOnline: true,
  })
  expect(help.exit).toBe(0)
  expect(help.onlineCalled).toBe(false)
  expect(help.stdout.replace(/\s+/g, " ")).toContain("missing directory")
  await invalid([
    "sync",
    "local",
    "connect",
    "11111111-1111-4111-8111-111111111111",
    "--path",
    "missing-local",
    "--from",
    "unknown",
  ])
  await invalid(["sync", "local", "connect", "11111111-1111-4111-8111-111111111111"])
})

test("daily management schema excludes historical operator commands offline", async () => {
  const upstream = await invoke(["schema", "sync", "upstream"], {
    inaccessible: true,
    traceOnline: true,
  })
  expect(upstream.exit).toBe(0)
  expect(upstream.onlineCalled).toBe(false)
  const upstreamCommands = JSON.parse(upstream.stdout).schema.commands.map(
    (command: { name: string }) => command.name,
  )
  for (const name of [
    "connect",
    "list",
    "add",
    "update",
    "remove",
    "status",
    "check",
    "plan",
    "apply",
    "run",
    "fork",
    "track",
  ])
    expect(upstreamCommands).toContain(name)
  for (const name of [
    "publish-files",
    "content-adopt-plan",
    "content-adopt-apply",
    "source-rich-text-repair-plan",
    "source-rich-text-repair-apply",
    "source-rich-text-repair-reconcile",
    "source-rich-text-repair-show",
    "source-root-fidelity-plan",
    "source-root-fidelity-apply",
    "source-root-fidelity-reconcile",
    "source-root-fidelity-show",
    "source-root-completion-plan",
    "source-root-completion-apply",
    "source-root-completion-reconcile",
    "source-root-completion-show",
    "map-checkpoint-adopt-plan",
    "map-checkpoint-adopt-apply",
    "adopt-plan",
    "adopt-apply",
    "prepare-plan",
    "prepare-apply",
    "rebuild",
    "restore-deleted",
  ])
    expect(upstreamCommands).not.toContain(name)
  const operation = await invoke(["schema", "operation"], { inaccessible: true, traceOnline: true })
  expect(operation.exit).toBe(0)
  expect(operation.onlineCalled).toBe(false)
  expect(
    JSON.parse(operation.stdout)
      .schema.commands.map((command: { name: string }) => command.name)
      .sort(),
  ).toEqual(["list", "reconcile", "resume", "show"])
  await invalid(["sync", "upstream", "content-adopt-plan", "--input", "missing.json"])
  await invalid(["sync", "upstream", "adopt-plan", "--evidence", "missing.json"])
  await invalid(["operation", "body-completion-plan", "p_fixture"])
}, 30000)

test("implicit root help works offline", async () => {
  const result = await invoke([], { inaccessible: true, traceOnline: true })
  expect(result.exit).toBe(0)
  expect(result.stderr).toBe("")
  expect(result.onlineCalled).toBe(false)
})

for (const command of [
  ["list"],
  ["ctl", "database", "list"],
  ["read", "sample"],
  ["files", "sample"],
  ["files", "sample"],
  ["create", "missing.md"],
  ["replace", "missing.md", "--target", "11111111-1111-4111-8111-111111111111"],
  ["export", "sample", "--output", "output.zip"],
  ["write", "sample", "--input", "missing.md"],
  ["ctl", "database", "register", "personal"],
  ["sync", "local", "bind", "sample", "--path", "local"],
  ["ctl", "cache", "status", "sample"],
  ["ctl", "cache", "clear", "sample"],
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
    [
      "replace",
      "missing.md",
      "--target",
      "11111111-1111-4111-8111-111111111111",
      "--target=sample",
    ],
    [
      "replace",
      "missing.md",
      "--target",
      "11111111-1111-4111-8111-111111111111",
      "--name",
      "Sample",
      "--name=Sample",
    ],
    ["create", "missing.md", "--description", "a", "--description=a"],
    [
      "replace",
      "missing.md",
      "--target",
      "11111111-1111-4111-8111-111111111111",
      "--dry-run",
      "--dry-run",
    ],
    ["sync", "local", "bind", "sample", "--path", "a", "--path=a"],
    ["sync", "local", "bind", "sample", "--path", "a", "--as", "b", "--as=b"],
    ["sync", "local", "plan", "--all", "--all"],
    ["sync", "local", "plan", "b", "--from", "local", "--from=local"],
    ["sync", "local", "plan", "b", "--output", "a.json", "--output=a.json"],
    ["sync", "local", "apply", "--plan", "p_a", "--plan=p_a"],
    ["sync", "local", "status", "--refresh", "--refresh"],
    ["sync", "local", "unbind", "b", "--dry-run", "--dry-run"],
    ["ctl", "cache", "clear", "--all", "--all"],
    ["ctl", "cache", "clear", "--all", "--dry-run", "--dry-run"],
    ["ctl", "config", "set-token", "--stdin", "--stdin"],
    ["operation", "resume", "p_fixture", "--progress", "--progress"],
    ["create", "missing.md", "--progress", "--progress"],
    [
      "replace",
      "missing.md",
      "--target",
      "11111111-1111-4111-8111-111111111111",
      "--progress",
      "--progress",
    ],
    ["write", "sample", "--input", "missing.md", "--progress", "--progress"],
    ["ctl", "builtin", "publish", "notion/ntn-skills-maintain", "--progress", "--progress"],
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
  for (const milliseconds of [0, 1000, 120000, 10800000, 345600000]) {
    const result = await invoke(
      ["ctl", "config", "set", "cache_policy.read_max_age_ms", String(milliseconds)],
      {
        root,
      },
    )
    expect(result.exit).toBe(0)
    expect(JSON.parse(result.stdout).config.effective_cache_policy.read_max_age_ms).toBe(
      milliseconds,
    )
    const show = JSON.parse((await invoke(["ctl", "config", "show"], { root })).stdout)
    expect(show.config.effective_cache_policy.read_max_age_ms).toBe(milliseconds)
    expect(show.config.default_database).toBe(original.default_database)
    expect(show.config.token_configured).toBe(true)
    expect(show.config.token).toBeUndefined()
  }
  for (const duration of ["-1", "1s", "1.5", "9007199254740992"]) {
    for (const key of ["cache_policy.read_max_age_ms", "cache_policy.catalog_max_age_ms"])
      await invalid(["ctl", "config", "set", key, duration])
  }
  const clear = await invoke(["ctl", "config", "unset", "cache_policy.read_max_age_ms"], { root })
  expect(clear.exit).toBe(0)
  const show = JSON.parse((await invoke(["ctl", "config", "show"], { root })).stdout)
  expect(show.config.effective_cache_policy).toEqual({
    read_max_age_ms: 300000,
    catalog_max_age_ms: 60000,
  })
  expect(show.config.default_database).toBe(original.default_database)
  expect(show.config.token_configured).toBe(true)
}, 60000)

test("consumer catalog identity follows remote scope without local configuration partitions", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntn-skills-catalog-identity-"))
  await mkdir(join(root, "config"))
  const database = "11111111-1111-4111-8111-111111111111"
  const otherDatabase = "22222222-2222-4222-8222-222222222222"
  const source = { alias: "shared", database_id: database, title: "Shared", data_source_ids: [] }
  const original = { token: "offline-fixture-token", sources: [source] }
  const save = (value: unknown) =>
    writeFile(join(root, "config", "config.json"), JSON.stringify(value))
  const identity = async (selector?: string) => {
    const result = await invoke(
      ["ctl", "cache", "identity", ...(selector ? ["--database", selector] : [])],
      { root, traceOnline: true },
    )
    expect(result.exit).toBe(0)
    expect(result.onlineCalled).toBe(false)
    expect(result.stdout).not.toContain(original.token)
    return JSON.parse(result.stdout)
  }
  await save(original)
  const first = await identity(database)
  expect((await identity("shared")).identity).toBe(first.identity)
  expect((await identity(database.replaceAll("-", "").toUpperCase())).identity).toBe(first.identity)
  expect((await identity()).identity).not.toBe(first.identity)
  const localPreferences = {
    ...original,
    default_database: otherDatabase,
    builtin_database: otherDatabase,
    cache_policy: { read_max_age_ms: 1000, catalog_max_age_ms: 120000 },
  }
  await save(localPreferences)
  const changedPolicy = await identity(database)
  expect(changedPolicy.identity).toBe(first.identity)
  expect(changedPolicy.catalog_max_age_ms).toBe(120000)
  expect((await identity(otherDatabase)).identity).not.toBe(first.identity)
  await save({ ...original, upstream_database: otherDatabase })
  expect((await identity(database)).identity).not.toBe(first.identity)
  await save({ ...original, token: "another-offline-credential" })
  expect((await identity(database)).identity).not.toBe(first.identity)
}, 30000)

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

test("built-ins are explicit offline package identities and cannot capture remote name lookup", async () => {
  const ids = ["notion/ntn-skills", "notion/ntn-skills-maintain", "notion/ntn-skills-sync"]
  const listed = await invoke(["ctl", "builtin", "list"], { traceOnline: true })
  expect(listed.exit).toBe(0)
  expect(listed.onlineCalled).toBe(false)
  for (const id of ids) {
    const name = id.slice("notion/".length)
    const item = JSON.parse(listed.stdout).skills.find((skill: { id: string }) => skill.id === id)
    expect(item).toMatchObject({ origin: "builtin", publisher: "ntn-skills", name })
    jsonFailure(await invoke(["ctl", "builtin", "read", name]), "BUILTIN_NOT_FOUND", 1)
    jsonFailure(
      await invoke(["ctl", "builtin", "read", id, "--path", "../private"]),
      "INVALID_PATH",
      1,
    )
    jsonFailure(await invoke(["read", name]), "NTN_UNAVAILABLE", 1)
  }
  await invalid(["ctl", "builtin", "publish", ids[1]!, "--target", "Ntn Skills Maintain"])
  await invalid(["ctl", "builtin", "publish", ids[1]!, "--database", "a", "--database", "b"])
}, 30000)

test("built-in management defaults to central storage and persists repeated agent targets under Node", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ntn-skills-cli-builtin-")))
  const bundle = await Bun.build({
    entrypoints: [main],
    outdir: join(root, "bundle"),
    naming: "ntn-skills.mjs",
    target: "node",
    format: "esm",
    external: [
      "effect",
      "effect/*",
      "@effect/platform-node",
      "@effect/platform-node/*",
      "@effect/sql-sqlite-node",
      "@effect/sql-sqlite-node/*",
    ],
  })
  if (!bundle.success) throw new AggregateError(bundle.logs, "CLI regression bundle failed")
  const entrypoint = join(root, "bundle", "ntn-skills.mjs")
  await symlink(
    new URL("../node_modules", import.meta.url).pathname,
    join(root, "bundle", "node_modules"),
    "dir",
  )
  const id = "notion/ntn-skills-maintain"
  const name = "ntn-skills-maintain"
  const dataDir = join(root, "xdg-data", "ntn-skills")
  const canonical = join(dataDir, "skills", name)
  const agents = [join(root, "home", ".agents"), join(root, "agent-one"), join(root, "agent two")]
  const targets = agents.slice(1).flatMap((directory) => ["--agent-dir", directory])
  const call = async (args: string[]) => {
    const result = await invoke(["ctl", "builtin", ...args], {
      root,
      traceOnline: true,
      runtime: node,
      entrypoint,
    })
    if (result.exit !== 0)
      throw new Error(
        `Builtin Node ${JSON.stringify(args)} exited ${result.exit}: ${result.stderr || result.stdout}`,
      )
    expect(result.exit).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.onlineCalled).toBe(false)
    return JSON.parse(result.stdout)
  }

  const listed = await call(["list"])
  expect(listed.data_dir).toBe(dataDir)
  expect(listed.skills.find((skill: { id: string }) => skill.id === id).installation).toMatchObject(
    {
      state: "not_installed",
      data_dir: dataDir,
      path: canonical,
      distributions: [
        { agent_dir: agents[0], path: join(agents[0]!, "skills", name), state: "missing" },
      ],
    },
  )
  const absent = await call(["status", id, ...targets])
  expect(absent.skills[0].installation.distributions).toHaveLength(3)
  for (const path of [dataDir, ...agents])
    expect(
      await access(path).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
  jsonFailure(
    await invoke(["ctl", "builtin", "update", id], { root, runtime: node, entrypoint }),
    "BUILTIN_NOT_INSTALLED",
    1,
  )

  const installed = await call(["install", id])
  expect(installed.reused).toBe(false)
  expect(installed.installation).toMatchObject({
    state: "current",
    data_dir: dataDir,
    path: canonical,
  })
  expect(await readlink(join(agents[0]!, "skills", name))).toBe(canonical)
  const distributed = await call(["install", id, ...targets])
  expect(distributed.reused).toBe(true)
  expect(distributed.installation.path).toBe(canonical)
  for (const agent of agents) {
    const path = join(agent, "skills", name)
    expect(distributed.installation.distributions).toContainEqual({
      agent_dir: agent,
      path,
      state: "linked",
    })
    expect(await readlink(path)).toBe(canonical)
    expect(await realpath(path)).toBe(canonical)
  }
  for (const command of [
    ["list", ...targets],
    ["list"],
    ["status", id, ...targets],
    ["status", id],
  ]) {
    const status = await call(command)
    const installation = status.skills.find((skill: { id: string }) => skill.id === id).installation
    expect(installation.state).toBe("current")
    expect(installation.distributions).toHaveLength(3)
    expect(
      installation.distributions.every((target: { state: string }) => target.state === "linked"),
    ).toBe(true)
  }
  for (const flags of [targets, []]) {
    const updated = await call(["update", id, ...flags])
    expect(updated.reused).toBe(true)
    expect(updated.installation.distributions).toHaveLength(3)
  }
}, 60000)

test("ctl configuration accepts only supported keys and preserves independent settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntn-skills-config-contract-"))
  const call = async (args: string[]) => {
    const result = await invoke(["ctl", "config", ...args], { root, traceOnline: true })
    expect(result.exit).toBe(0)
    expect(result.onlineCalled).toBe(false)
    return JSON.parse(result.stdout).config
  }
  expect(
    (await call(["set", "cache_policy.read_max_age_ms", "1234"])).effective_cache_policy
      .read_max_age_ms,
  ).toBe(1234)
  expect(
    (await call(["set", "cache_policy.catalog_max_age_ms", "5678"])).effective_cache_policy,
  ).toEqual({ read_max_age_ms: 1234, catalog_max_age_ms: 5678 })
  expect((await call(["unset", "cache_policy.read_max_age_ms"])).effective_cache_policy).toEqual({
    read_max_age_ms: 300000,
    catalog_max_age_ms: 5678,
  })
  expect((await call(["unset", "cache_policy.catalog_max_age_ms"])).effective_cache_policy).toEqual(
    { read_max_age_ms: 300000, catalog_max_age_ms: 60000 },
  )
  for (const args of [
    ["set", "token", "secret"],
    ["unset", "token"],
    ["set", "unknown", "value"],
    ["set", "cache_policy.read_max_age_ms", "5m"],
    ["set", "cache_policy.read_max_age_ms", "1.5"],
    ["set", "cache_policy.read_max_age_ms", "9007199254740992"],
    ["set-default", "ops"],
    ["clear-default"],
    ["set-cache-policy", "--read-max-age", "5m"],
    ["clear-cache-policy"],
    ["set-builtin-database", "ops"],
    ["clear-builtin-database"],
  ])
    await invalid(["ctl", "config", ...args])
}, 60000)

test("ctl database unregister removes only an exact local registration", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntn-skills-database-contract-"))
  await mkdir(join(root, "config"), { recursive: true })
  const source = {
    alias: "ops",
    database_id: "11111111-1111-4111-8111-111111111111",
    title: "Operations",
    data_source_ids: [],
  }
  await writeFile(
    join(root, "config", "config.json"),
    JSON.stringify({ sources: [source], default_database: source.database_id }),
  )
  const missing = await invoke(["ctl", "database", "unregister", "OPS"], {
    root,
    traceOnline: true,
  })
  jsonFailure(missing, "DATABASE_NOT_FOUND", 1)
  expect(missing.onlineCalled).toBe(false)
  const removed = await invoke(["ctl", "database", "unregister", "ops"], {
    root,
    traceOnline: true,
  })
  expect(removed.exit).toBe(0)
  expect(removed.onlineCalled).toBe(false)
  expect(JSON.parse(removed.stdout)).toMatchObject({ unregistered: [source], sources: [] })
  const shown = await invoke(["ctl", "config", "show"], { root })
  expect(JSON.parse(shown.stdout).config).toMatchObject({
    sources: [],
    default_database: source.database_id,
  })
  for (const args of [["add", "ops", "--database", source.database_id], ["registered"]])
    await invalid(["ctl", "database", ...args])
}, 30000)
