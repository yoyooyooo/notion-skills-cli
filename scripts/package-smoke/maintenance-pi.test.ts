import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { resolveConsumerRuntime } from "./consumer.ts"
import { maintenancePiInitialMain, prepareMaintenancePiIntent } from "./maintenance-pi-gate.ts"
import {
  acceptanceFailures,
  oracleProjection,
  verifyMaintenanceResource,
  toolCallsFrom,
  decodedWireModelText,
  checkPinsOutsideMock,
  maintenanceProgress,
  maintenanceTaskText,
  parseExactlyOneJsonObject,
  quoteArgv,
  runMaintenancePi,
  selectMaintenanceCall,
  type AuthoringContinuation,
  type MaintenanceTask,
  type VisibleMessage,
} from "./maintenance-pi.ts"

const task: MaintenanceTask = {
  cli: ["/usr/bin/node", "/opt/ntn-skills.js"],
  target: "page-target",
  entry: "db-entry",
  input_dir: "/tmp/mnt-input",
  current_main_file: "/tmp/mnt-current-main.md",
}

test("the current Pi fixture leaves both new refs unallocated and splits every original paragraph", async () => {
  const root = await mkdtemp(join(tmpdir(), "mnt-single-intent-"))
  const directories = new Map<string, Record<string, string>>()
  const reads: string[][] = []
  let writes = 0
  const prepared = await prepareMaintenancePiIntent(
    {
      target: "page-target",
      database: "db-entry",
      noWrites: async (_label, args) => {
        reads.push(args)
        return {
          ref: "skill://page-target/SKILL.md?snapshot=original",
          snapshot_id: "original",
          content: maintenancePiInitialMain,
          file_bindings: [{ path: "SKILL.md", page_id: "page-target", file_id: "main" }],
        }
      },
      invoke: async () => {
        writes += 1
        throw new Error("New references must be created by Pi's one apply")
      },
      directory: async (name, files) => {
        directories.set(name, files)
        return join(root, name)
      },
    },
    root,
  )
  assert.equal(writes, 0)
  assert.equal(reads.length, 1)
  assert.ok(reads[0]?.includes("--refresh"))
  assert.deepEqual([...directories.keys()], ["requested-input"])
  assert.ok(Buffer.byteLength(maintenancePiInitialMain) > 5_000)
  const overview = prepared.files["SKILL.md"].split("\n\n[First guide]")[0]
  assert.equal(
    [overview, prepared.files["references/pi-one.md"], prepared.files["references/pi-two.md"]].join(
      "\n\n",
    ),
    maintenancePiInitialMain.trimEnd(),
  )
  const stage = JSON.parse(await readFile(join(root, "fixture-stage.json"), "utf8"))
  assert.equal(stage.preallocated_references, false)
  assert.equal(stage.legacy_result, null)
  assert.equal(stage.original_file_bindings.length, 1)
  assert.equal(stage.requested_files.length, 3)
})

test("the former preallocated Pi fixture stays explicit and cannot masquerade as single apply", async () => {
  const root = await mkdtemp(join(tmpdir(), "mnt-legacy-intent-"))
  const writes: string[][] = []
  const directories: string[] = []
  await prepareMaintenancePiIntent(
    {
      target: "page-target",
      database: "db-entry",
      noWrites: async () => ({
        ref: "skill://page-target/SKILL.md?snapshot=original",
        snapshot_id: "original",
        content: maintenancePiInitialMain,
        file_bindings: [{ path: "SKILL.md" }],
      }),
      invoke: async (_label, args) => {
        writes.push(args)
        return { verified: true, status: "applied" }
      },
      directory: async (name) => {
        directories.push(name)
        return join(root, name)
      },
    },
    root,
    "legacy-preallocated",
  )
  assert.deepEqual(directories, ["pi-native-reference-baseline", "requested-input"])
  assert.equal(writes.length, 1)
  assert.equal(writes[0]?.[0], "apply")
  const stage = JSON.parse(await readFile(join(root, "fixture-stage.json"), "utf8"))
  assert.equal(stage.mode, "legacy-preallocated")
  assert.equal(stage.preallocated_references, true)
  assert.equal(stage.scope, "public_installed_cli_reference_allocation_before_pi")
})

test("an already allocated reference rejects the current Pi fixture before any write", async () => {
  const root = await mkdtemp(join(tmpdir(), "mnt-invalid-intent-"))
  let calls = 0
  await assert.rejects(
    prepareMaintenancePiIntent(
      {
        target: "page-target",
        database: "db-entry",
        noWrites: async () => ({
          ref: "skill://page-target/SKILL.md?snapshot=original",
          snapshot_id: "original",
          content: maintenancePiInitialMain,
          file_bindings: [{ path: "references/pi-one.md" }],
        }),
        invoke: async () => {
          calls += 1
        },
        directory: async () => {
          calls += 1
          return root
        },
      },
      root,
    ),
    /PI_REFERENCE_ALREADY_ALLOCATED/,
  )
  assert.equal(calls, 0)
})

test("posthoc main oracle resolves only observed owned native links and retains literal or foreign spans", () => {
  const target = "00000000-0000-4000-8000-000000000001"
  const page = "00000000-0000-4000-8000-000000000002"
  const foreign = "00000000-0000-4000-8000-000000000003"
  const url = `https://app.notion.com/p/${page.replaceAll("-", "")}`
  const outside = `https://app.notion.com/p/${foreign.replaceAll("-", "")}`
  const body = `# Main\n\n[Guide](${url})\n\n\`[literal](${url})\`\n\n<code>[literal](${url})</code>\n\n[Foreign](${outside})\n\n\`\`\`text\n[example](${url})\n\`\`\``
  const row = (id: string, owner: string, path: string) => ({
    id,
    properties: {
      skill: { relation: [{ id: owner }] },
      path: { rich_text: [{ plain_text: path }] },
    },
  })
  const observed: ReturnType<AuthoringContinuation["observe"]> = {
    skills: [],
    records: [],
    calls: [],
    bodies: [[target, body]],
    files: [
      row(page, target, "references/guide.md"),
      row(foreign, "another-owner", "references/foreign.md"),
    ],
  }
  const actual = oracleProjection(observed, target)
  assert.equal(actual.nativeBody, body)
  assert.equal(actual.body, body.replace(`[Guide](${url})`, "[Guide](references/guide.md)"))
  assert.deepEqual(actual.directoryPaths, ["references/guide.md"])
  assert.throws(
    () => oracleProjection({ ...observed, files: [...observed.files, observed.files[0]] }, target),
    /ORACLE_NATIVE_BINDING_AMBIGUOUS/,
  )
})

test("the installed consumer resolves a home-dependent Node launcher before Pi isolation", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "mnt-node-launcher-"))
  const home = process.env.HOME
  assert.ok(home)
  const node = execFileSync("node", ["--print", "process.execPath"], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim()
  const launcher = join(root, "node-launcher")
  await writeFile(
    launcher,
    `#!/bin/sh\n[ "$HOME" = ${quoteArgv([home])} ] || exit 73\nexec ${quoteArgv([node])} "$@"\n`,
    { mode: 0o700 },
  )
  const env = { HOME: join(root, "isolated-home"), PATH: "/usr/bin:/bin" }
  assert.throws(() => execFileSync(launcher, ["--version"], { env, timeout: 5_000 }))
  const runtime = resolveConsumerRuntime(launcher)
  const observed = JSON.parse(
    execFileSync(
      runtime,
      ["--print", "JSON.stringify({node:process.execPath,home:process.env.HOME})"],
      { env, encoding: "utf8", timeout: 5_000 },
    ),
  )
  assert.equal(observed.node, node)
  assert.equal(observed.home, env.HOME)
  assert.notEqual(runtime, launcher)
})

const secret = "EXPECTED_BODY_SHOULD_NOT_LEAK"
const preparedOk = JSON.stringify({
  ok: true,
  records: [
    {
      ref: "sr:Smain",
      content: "Complete main",
      directory: {
        files: [
          { path: "SKILL.md", ref: "sr:Smain", bytes: 13 },
          { path: "references/a.md", ref: "sr:Rresource", bytes: 17 },
        ],
        required: [],
        candidates: [],
        references: [],
      },
    },
  ],
})

function user(content: string): VisibleMessage {
  return { role: "user", content }
}

function tool(id: string, name: string, text: string, isError = false): VisibleMessage[] {
  return [
    { role: "assistant", content: [{ type: "toolCall", id, name, arguments: {} }] },
    { role: "toolResult", toolCallId: id, toolName: name, isError, content: text },
  ]
}

const json = (value: unknown) => JSON.stringify(value)

const auditOk = json({
  ok: true,
  run_id: "audit-1",
  execution: "completed",
  coverage: "full",
  severity: { error: 0 },
})
const authoringOk = json({
  ok: true,
  ref: "skill://page-target/SKILL.md?snapshot=old",
  content: "current main",
  record: { enabled: true },
})
const dryOk = json({ ok: true, dry_run: true })
const appliedOk = json({
  ok: true,
  verified: true,
  status: "applied",
  apply_operation_id: "op-1",
  ref: "skill://page-target/SKILL.md?snapshot=new",
  record: { enabled: true },
})
const layout = `${json({
  ok: false,
  error: {
    code: "SHARED_APPLY_LAYOUT_BATCH_UNSUPPORTED",
    message: "No writes were sent.",
    details: { writes_sent: false },
  },
})}\n\nCommand exited with code 1`
const showOk = json({
  ok: true,
  operation_id: "op-1",
  verified: false,
  next: {
    argv: [
      "ntn-skills",
      "ctl",
      "operation",
      "reconcile",
      "op-1",
      "--target",
      "page-target",
      "--entry",
      "db-entry",
    ],
    read_only: true,
  },
})
const reconcileOk = json({
  ok: true,
  operation_id: "op-1",
  verified: true,
  record: { enabled: true },
})

function chain(messages: VisibleMessage[]) {
  return { messages: [user(maintenanceTaskText(task)), ...messages] }
}

test("one JSON object allows a text prefix and rejects truncation or a second object", () => {
  const parsed = parseExactlyOneJsonObject(`notice ${auditOk}\nCommand exited with code 3`)
  assert.equal(parsed.run_id, "audit-1")
  assert.throws(() => parseExactlyOneJsonObject('{"ok":true,"execution":'), /CLI_JSON_TRUNCATED/)
  assert.throws(() => parseExactlyOneJsonObject(`${auditOk}{"run_id":`), /CLI_JSON_TRUNCATED/)
  assert.throws(
    () => parseExactlyOneJsonObject(`${auditOk}${json({ ok: true, extra: 1 })}`),
    /CLI_JSON_NOT_UNIQUE/,
  )
  assert.throws(() => parseExactlyOneJsonObject("{}"), /CLI_JSON_NOT_MEANINGFUL/)
  assert.throws(() => parseExactlyOneJsonObject("{not json}"), /CLI_JSON_INVALID/)
})

test("argv quoting is single-quoted and does not use JSON double quotes", () => {
  assert.equal(quoteArgv(["bin", "a$b`c", "x y", "it's"]), "'bin' 'a$b`c' 'x y' 'it'\\''s'")
  assert.equal(quoteArgv(["echo", ""]).includes('"'), false)
})

test("the visible task and first call do not contain a hidden body", () => {
  const text = maintenanceTaskText(task)
  assert.equal(text.includes(secret), false)
  assert.equal(text.includes("/tmp/mnt-current-main.md"), true)
  const call = selectMaintenanceCall({ messages: [user(text)] })
  assert.equal(call?.id, "mnt-audit")
  assert.equal(call?.name, "bash")
  assert.equal(JSON.stringify(call).includes(secret), false)
  assert.match(
    String(call?.arguments.command),
    /'ctl' 'audit' 'run' '--target' 'page-target' '--entry' 'db-entry'/,
  )
})

test("an oracle field in the visible task is rejected before a tool call", () => {
  const poisoned = maintenanceTaskText(task).replace(
    `"target":"page-target"`,
    `"target":"page-target","oracle":"${secret}"`,
  )
  assert.throws(
    () => selectMaintenanceCall({ messages: [user(poisoned)] }),
    /MNT_TASK_ORACLE_REJECTED/,
  )
})

test("layout unsupported and partial previews never fall back to an unrelated write", () => {
  const ready = chain([
    ...tool("mnt-audit", "bash", auditOk),
    ...tool("mnt-authoring-read", "bash", authoringOk),
  ])
  const dry = selectMaintenanceCall(ready)
  assert.equal(dry?.id, "mnt-apply-dry")
  assert.match(
    String(dry?.arguments.command),
    /'apply' 'skill:\/\/page-target\/SKILL.md\?snapshot=old' '--input' '\/tmp\/mnt-input' '--dry-run'/,
  )
  const unsupported = selectMaintenanceCall(
    chain([...ready.messages.slice(1), ...tool("mnt-apply-dry", "bash", layout, true)]),
  )
  assert.equal(unsupported, null)
  const partial = json({
    ok: false,
    error: { code: "SHARED_APPLY_PARTIAL", message: "stopped", details: { writes_sent: true } },
  })
  const stopped = selectMaintenanceCall(
    chain([
      ...ready.messages.slice(1),
      ...tool("mnt-apply-dry", "bash", `${partial}\n\nCommand exited with code 1`, true),
    ]),
  )
  assert.equal(stopped, null)
  const unbound = json({
    ok: false,
    error: {
      code: "SHARED_NATIVE_REFERENCE_UNBOUND",
      message: "Allocate native references first.",
      details: { writes_sent: false },
    },
  })
  assert.equal(
    selectMaintenanceCall(
      chain([
        ...ready.messages.slice(1),
        ...tool("mnt-apply-dry", "bash", `${unbound}\n\nCommand exited with code 1`, true),
      ]),
    ),
    null,
    "The Pi selector must not repair an unsupported plan by inventing a different write",
  )
})

test("a successful dry-run applies once, then copies show next.argv", () => {
  const beforeApply = chain([
    ...tool("mnt-audit", "bash", auditOk),
    ...tool("mnt-authoring-read", "bash", authoringOk),
    ...tool("mnt-apply-dry", "bash", dryOk),
  ])
  const apply = selectMaintenanceCall(beforeApply)
  assert.equal(apply?.id, "mnt-apply")
  assert.equal(String(apply?.arguments.command).includes("--dry-run"), false)
  const afterApply = chain([
    ...beforeApply.messages.slice(1),
    ...tool("mnt-apply", "bash", appliedOk),
  ])
  const show = selectMaintenanceCall(afterApply)
  assert.equal(show?.id, "mnt-operation-show")
  assert.match(
    String(show?.arguments.command),
    /'ctl' 'operation' 'show' 'op-1' '--target' 'page-target' '--entry' 'db-entry'/,
  )
  const afterShow = chain([
    ...afterApply.messages.slice(1),
    ...tool("mnt-operation-show", "bash", showOk),
  ])
  const reconcile = selectMaintenanceCall(afterShow)
  assert.equal(reconcile?.id, "mnt-operation-reconcile")
  assert.match(String(reconcile?.arguments.command), /'ctl' 'operation' 'reconcile' 'op-1'/)
  assert.equal(String(reconcile?.arguments.command).includes("op-guess"), false)
})

test("unknown apply result does not retry the write", () => {
  const unknown = json({ ok: true, status: "unknown", apply_operation_id: "op-1" })
  const call = selectMaintenanceCall(
    chain([
      ...tool("mnt-audit", "bash", auditOk),
      ...tool("mnt-authoring-read", "bash", authoringOk),
      ...tool("mnt-apply-dry", "bash", dryOk),
      ...tool("mnt-apply", "bash", unknown),
    ]),
  )
  assert.equal(call, null)
  const progress = maintenanceProgress(
    chain([
      ...tool("mnt-audit", "bash", auditOk),
      ...tool("mnt-authoring-read", "bash", authoringOk),
      ...tool("mnt-apply-dry", "bash", dryOk),
      ...tool("mnt-apply", "bash", unknown),
    ]),
  )
  assert.equal(progress.chain, "incomplete")
  assert.equal(progress.steps.find((step) => step.id === "mnt-apply")?.state, "stop")
})

test("enabled tool results schedule notion_use, read, and one repeat read", () => {
  const base = [
    ...tool("mnt-audit", "bash", auditOk),
    ...tool("mnt-authoring-read", "bash", authoringOk),
    ...tool("mnt-apply-dry", "bash", dryOk),
    ...tool("mnt-apply", "bash", appliedOk),
    ...tool("mnt-operation-show", "bash", showOk),
    ...tool("mnt-operation-reconcile", "bash", reconcileOk),
  ]
  const use = selectMaintenanceCall(chain(base))
  assert.deepEqual(use, {
    type: "toolCall",
    id: "mnt-notion-use",
    name: "notion_use",
    arguments: { ref: "skill://page-target/SKILL.md?snapshot=new", readOnly: true },
  })
  const read = selectMaintenanceCall(
    chain([...base, ...tool("mnt-notion-use", "notion_use", preparedOk)]),
  )
  assert.equal(read?.id, "mnt-read")
  assert.deepEqual(read?.arguments, { path: "sr:Rresource" })
  const repeat = selectMaintenanceCall(
    chain([
      ...base,
      ...tool("mnt-notion-use", "notion_use", preparedOk),
      ...tool("mnt-read", "read", "body once"),
    ]),
  )
  assert.equal(repeat?.id, "mnt-read-repeat")
  assert.deepEqual(repeat?.arguments, { path: "sr:Rresource" })
  assert.equal(
    selectMaintenanceCall(
      chain([
        ...base,
        ...tool("mnt-notion-use", "notion_use", preparedOk),
        ...tool("mnt-read", "read", "body once"),
        ...tool("mnt-read-repeat", "read", "body once"),
      ]),
    ),
    null,
  )
  const disabled = authoringOk.replace(`"enabled":true`, `"enabled":false`)
  const noConsume = selectMaintenanceCall(
    chain([
      ...tool("mnt-audit", "bash", auditOk),
      ...tool("mnt-authoring-read", "bash", disabled),
      ...tool("mnt-apply-dry", "bash", dryOk),
      ...tool("mnt-apply", "bash", appliedOk.replace(`"enabled":true`, `"enabled":false`)),
      ...tool("mnt-operation-show", "bash", showOk),
      ...tool(
        "mnt-operation-reconcile",
        "bash",
        reconcileOk.replace(`"enabled":true`, `"enabled":false`),
      ),
    ]),
  )
  assert.equal(noConsume, null)
})

test("acceptance fails when tool results, body source, wire capture, or the native session is missing", () => {
  const good = {
    toolCalls: [{ id: "mnt-notion-use", name: "notion_use", resultText: preparedOk }],
    http: [{ entityBytes: 20, sseBytes: 10 }],
    sessionJsonlBytes: 40,
    finalRequestText: `prefix ${secret}\nreferences/a.md`,
    sourceBody: secret,
    directoryPaths: ["references/a.md"],
    finalRequestEntity: JSON.stringify({
      messages: [{ role: "tool", tool_call_id: "mnt-notion-use", content: preparedOk }],
    }),
  }
  assert.deepEqual(acceptanceFailures(good), [])
  assert.ok(acceptanceFailures({ ...good, toolCalls: [] }).includes("missing_tool_call"))
  assert.ok(
    acceptanceFailures({
      ...good,
      toolCalls: [{ id: "mnt-audit", name: "bash", resultText: null }],
    }).includes("missing_tool_call"),
  )
  assert.ok(
    acceptanceFailures({ ...good, http: [{ entityBytes: 0, sseBytes: 10 }] }).includes(
      "missing_wire_capture",
    ),
  )
  assert.ok(
    acceptanceFailures({ ...good, http: [{ entityBytes: 20, sseBytes: 0 }] }).includes(
      "missing_wire_capture",
    ),
  )
  assert.ok(
    acceptanceFailures({ ...good, sessionJsonlBytes: 0 }).includes("missing_native_session"),
  )
  assert.ok(acceptanceFailures({ ...good, sourceBody: null }).includes("missing_body_source"))
  assert.ok(
    acceptanceFailures({ ...good, finalRequestText: "no body" }).includes("missing_body_source"),
  )
  assert.ok(
    acceptanceFailures({
      ...good,
      finalRequestText: `${secret}\n${secret}\nreferences/a.md`,
    }).includes("body_source_not_unique"),
  )
  assert.ok(acceptanceFailures({ ...good, directoryPaths: [] }).includes("missing_directory"))
  assert.ok(
    acceptanceFailures({
      ...good,
      finalRequestText: secret,
      directoryPaths: ["references/missing.md"],
    }).includes("missing_directory"),
  )
})

test("old and new pins are read outside the selector", async () => {
  const reads: string[][] = []
  const input = {
    target: "page-target",
    noWrites: async (_label: string, args: string[]) => {
      reads.push(args)
      const ref = args[1]
      return { content: ref?.includes("new") ? "split main" : "current main", has_more: false }
    },
    observe: () => ({
      skills: [],
      files: [],
      records: [],
      bodies: [["page-target", "split main"] as [string, string]],
      calls: [],
    }),
  } as unknown as AuthoringContinuation
  const report = await checkPinsOutsideMock(
    input,
    {
      steps: [],
      chain: "apply",
      consumption: "done",
      enabled: true,
      refs: {
        authoring: "skill://same/SKILL.md?snapshot=old",
        applied: "skill://same/SKILL.md?snapshot=new",
      },
    },
    { ref: "skill://same/SKILL.md?snapshot=old", content: "current main" },
  )
  assert.deepEqual(reads, [
    ["read", "skill://same/SKILL.md?snapshot=old", "--json", "--read-only"],
    ["read", "skill://same/SKILL.md?snapshot=new", "--json", "--read-only"],
  ])
  assert.equal(report.status, "preserved")
  assert.equal(report.new_pin_differs, true)
  assert.equal(report.oracle_used_for_selection, false)
})

test("real Pi smoke captures wire and session or records the candidate limit", {
  timeout: 180_000,
  skip: !process.env.MNT_BROKER_ROOT,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "mnt08-pi-"))
  const cli = join(root, "stand-in-cli.js")
  await writeFile(
    cli,
    `process.stdout.write(${JSON.stringify(json({ ok: false, error: { code: "SMOKE_NO_SERVICE", message: "no authoring continuation in this checkout" } }))} + "\\n"); process.exit(1)\n`,
  )
  const inputDir = join(root, "input")
  const mainFile = join(root, "current-main.md")
  await writeFile(mainFile, "current main\n")
  const { mkdir } = await import("node:fs/promises")
  await mkdir(inputDir)
  const output = join(root, "evidence")
  const brokerRoot = process.env.MNT_BROKER_ROOT
  assert.ok(brokerRoot)
  const input = {
    root,
    context: { runtime: process.execPath, executable: cli },
    env: {
      NOTION_API_BASE_URL: "http://127.0.0.1:9",
      NOTION_API_TOKEN: "fixture-no-secret",
      NOTION_WORKSPACE_ID: "",
    },
    target: "page-target",
    database: "db-entry",
    invoke: async () => {
      throw new Error("invoke must not run in the smoke")
    },
    noWrites: async () => {
      throw new Error("noWrites must not run before an authoring result")
    },
    directory: async () => inputDir,
    observe: () => ({ skills: [], files: [], records: [], bodies: [], calls: [] }),
    externalEdit: () => undefined,
    appendBeforeNextPatch: () => undefined,
    loseNextOutcome: () => undefined,
  } satisfies AuthoringContinuation
  await assert.rejects(
    runMaintenancePi(input, {
      brokerRoot,
      brokerPackage: process.env.MNT_BROKER_PACKAGE ?? join(brokerRoot, "packages/context-broker"),
      piHost: process.env.MNT_PI_HOST ?? "pi",
      output,
      inputDir,
      currentMainFile: mainFile,
      timeoutMs: 90_000,
    }),
    /MNT08_PI_failed/,
  )
  const result = JSON.parse(await readFile(join(output, "result.json"), "utf8")) as {
    status: string
    acceptance: string[]
    boundaries: { real_notion: boolean; real_model: boolean; real_pi: string }
    http: { bytes: number | null; sse_bytes: number; call: { name: string | null } | null }[]
    sessions: { bytes: number }[]
    chain: string
    split_applied: boolean
  }
  assert.equal(result.status, "failed")
  assert.equal(result.split_applied, false)
  assert.equal(result.boundaries.real_notion, false)
  assert.equal(result.boundaries.real_model, false)
  assert.ok(["1.4.0", "1.5.0", "1.5.2"].includes(result.boundaries.real_pi))
  assert.ok(result.http.some((item) => (item.bytes ?? 0) > 0 && item.sse_bytes > 0))
  assert.ok(result.sessions.some((item) => item.bytes > 0))
  assert.ok(result.acceptance.includes("missing_body_source") || result.chain === "incomplete")
  assert.equal(result.acceptance.includes("missing_wire_capture"), false)
  assert.equal(result.acceptance.includes("missing_native_session"), false)
  assert.equal(result.acceptance.includes("missing_tool_call"), false)
})

test("wire evidence decodes serializer escaping exactly once before comparing source bytes", () => {
  const body = '\uFEFF# Original 🧭\r\n\n{"author example":"literal"}\n'
  const entity = JSON.stringify({
    messages: [
      { role: "tool", content: JSON.stringify({ records: [{ content: body }] }) },
      { role: "user", content: "Only a reference remains" },
    ],
  })
  const visible = decodedWireModelText(entity)
  assert.ok(visible.startsWith(body))
  assert.equal(visible.split(body).length - 1, 1)
  assert.throws(() => decodedWireModelText('{"messages":[null]}'), /WIRE_MESSAGE_INVALID/)
  assert.throws(() => decodedWireModelText('{"messages":null}'), /WIRE_MESSAGES_MISSING/)
})

test("incomplete or error audits never authorize an authoring command", () => {
  for (const report of [
    { execution: "completed", run_id: "audit-1", coverage: "partial", severity: { error: 0 } },
    { execution: "completed", run_id: "audit-1", coverage: "full", severity: { error: 1 } },
    { execution: "paused", run_id: "audit-1", coverage: "partial", severity: { error: 0 } },
  ])
    assert.equal(
      selectMaintenanceCall(
        chain(tool("mnt-audit", "bash", JSON.stringify({ ok: true, ...report }))),
      ),
      null,
    )
})

test("directory uniqueness counts complete generated objects, not path mentions in author commands or reports", () => {
  const repeatedPaths = "references/a.md references/a.md references/a.md"
  const messages = [
    { role: "user", content: repeatedPaths },
    { role: "tool", tool_call_id: "management", content: JSON.stringify({ paths: repeatedPaths }) },
    { role: "tool", tool_call_id: "mnt-notion-use", content: preparedOk },
  ]
  const base = {
    toolCalls: [{ id: "mnt-notion-use", name: "notion_use", resultText: preparedOk }],
    http: [{ entityBytes: 200, sseBytes: 20 }],
    sessionJsonlBytes: 100,
    finalRequestText: secret + repeatedPaths,
    sourceBody: secret,
    directoryPaths: ["references/a.md"],
    finalRequestEntity: JSON.stringify({ messages }),
  }
  assert.deepEqual(acceptanceFailures(base), [])
  const duplicate = [...messages, messages.at(-1)]
  assert.ok(
    acceptanceFailures({
      ...base,
      finalRequestEntity: JSON.stringify({ messages: duplicate }),
    }).includes("directory_not_unique"),
  )
  assert.ok(
    acceptanceFailures({
      ...base,
      finalRequestEntity: JSON.stringify({ messages: messages.slice(0, -1) }),
    }).includes("missing_directory"),
  )
  const changed = JSON.parse(preparedOk)
  changed.records[0].directory.files.push(changed.records[0].directory.files[1])
  assert.ok(
    acceptanceFailures({
      ...base,
      finalRequestEntity: JSON.stringify({
        messages: [{ ...messages.at(-1), content: JSON.stringify(changed) }],
      }),
    }).includes("directory_not_unique"),
  )
})

test("a tool suggestion cannot redirect an original reconcile into another command or owner", () => {
  const previous = [
    ...tool("mnt-audit", "bash", auditOk),
    ...tool("mnt-authoring-read", "bash", authoringOk),
    ...tool("mnt-apply-dry", "bash", dryOk),
    ...tool("mnt-apply", "bash", appliedOk),
  ]
  for (const mutate of [
    (v: { operation_id: string; next: { argv: string[]; read_only: boolean } }) => {
      v.next.argv[3] = "resume"
    },
    (v: { operation_id: string; next: { argv: string[]; read_only: boolean } }) => {
      v.next.argv[4] = "other-op"
    },
    (v: { operation_id: string; next: { argv: string[]; read_only: boolean } }) => {
      v.next.argv[6] = "foreign-page"
    },
    (v: { operation_id: string; next: { argv: string[]; read_only: boolean } }) => {
      v.next.argv[8] = "foreign-library"
    },
    (v: { operation_id: string; next: { argv: string[]; read_only: boolean } }) => {
      v.next.read_only = false
    },
    (v: { operation_id: string; next: { argv: string[]; read_only: boolean } }) => {
      v.operation_id = "other-op"
    },
  ]) {
    const shown = JSON.parse(showOk)
    mutate(shown)
    assert.equal(
      selectMaintenanceCall(
        chain([...previous, ...tool("mnt-operation-show", "bash", JSON.stringify(shown))]),
      ),
      null,
    )
  }
})

test("native duplicate call IDs remain visible to the acceptance oracle", () => {
  const messages = [...tool("repeat", "read", "original"), ...tool("repeat", "read", "original")]
  const calls = toolCallsFrom(messages)
  assert.equal(calls.length, 2)
  const failures = acceptanceFailures({
    toolCalls: calls,
    http: [],
    sessionJsonlBytes: 10,
    finalRequestText: null,
    sourceBody: null,
    directoryPaths: [],
    finalRequestEntity: null,
  })
  assert.ok(failures.includes("tool_call_not_once"))
})

function resourceCase() {
  const body = "# Exact guide\n\nSOURCE_RESOURCE_COMPLETE.\n"
  const effects = { version: 1, remote_writes: "unknown", author_content: "unknown", retention: [] }
  const suffix = "\n\n<notion-effects>" + JSON.stringify(effects) + "</notion-effects>"
  const used = JSON.stringify({
    ok: true,
    records: [{ directory: { files: [{ path: "references/guide.md", ref: "sr:Rselected" }] } }],
  })
  const messages: VisibleMessage[] = [...tool("mnt-notion-use", "notion_use", used)]
  for (const id of ["mnt-read", "mnt-read-repeat"])
    messages.push(
      {
        role: "assistant",
        content: [{ type: "toolCall", id, name: "read", arguments: { path: "sr:Rselected" } }],
      },
      {
        role: "toolResult",
        toolCallId: id,
        toolName: "read",
        isError: false,
        content: body + suffix,
        details: { effects },
      },
    )
  const observed = {
    skills: [],
    records: [],
    calls: [],
    files: [
      {
        id: "owned-file",
        properties: {
          path: { rich_text: [{ plain_text: "references/guide.md" }] },
          file_id: { rich_text: [{ plain_text: "stable-file" }] },
          skill: { relation: [{ id: "owned" }] },
        },
      },
    ],
    bodies: [["owned-file", body] as [string, string]],
  }
  const entity = JSON.stringify({
    messages: [
      { role: "tool", tool_call_id: "mnt-read", content: body + suffix },
      { role: "tool", tool_call_id: "mnt-read-repeat", content: "Already available." + suffix },
    ],
  })
  return { messages, observed, entity, target: "owned" }
}

test("actual resource source and each operation effects survive once-only outgoing projection", () => {
  const input = resourceCase()
  const proof = verifyMaintenanceResource(input)
  assert.equal(proof.complete_copies, 1)
  assert.equal(proof.original_full_results, 2)
  assert.deepEqual(
    proof.effects.map((x) => x.remote_writes),
    ["unknown", "unknown"],
  )
  for (const change of [
    (x: ReturnType<typeof resourceCase>) => {
      x.entity = x.entity.replaceAll("unknown", "none")
    },
    (x: ReturnType<typeof resourceCase>) => {
      x.entity = x.entity.replace("Already available.", "Truncated")
    },
    (x: ReturnType<typeof resourceCase>) => {
      x.observed.files[0]!.properties.skill.relation[0]!.id = "foreign"
    },
    (x: ReturnType<typeof resourceCase>) => {
      x.messages.push(x.messages.at(-1)!)
    },
    (x: ReturnType<typeof resourceCase>) => {
      x.observed.bodies[0]![1] += "changed"
    },
  ]) {
    const broken = resourceCase()
    change(broken)
    assert.throws(() => verifyMaintenanceResource(broken))
  }
})

function splitResourceCase() {
  const input = resourceCase()
  const body = input.observed.bodies[0]![1]
  const originalTask = { ...task, target: input.target }
  const record = {
    id: "shared_skill:library:owned",
    locator: { page_id: input.target, database_id: task.entry },
  }
  const baseline = {
    ok: true,
    path: "SKILL.md",
    snapshot_id: "old",
    ref: "skill://shared_skill%3Alibrary%3Aowned/SKILL.md?snapshot=old&file_id=main-file",
    record,
    content: "# Original main\n\n" + body,
    file_bindings: [{ path: "SKILL.md", page_id: input.target, file_id: "main-file" }],
  }
  const original = JSON.stringify(baseline)
  const authoring = tool("mnt-authoring-read", "bash", original)
  authoring[0]!.content = [
    {
      type: "toolCall",
      id: "mnt-authoring-read",
      name: "bash",
      arguments: {
        command: quoteArgv([
          ...task.cli,
          "read",
          input.target,
          "--database",
          task.entry,
          "--authoring",
          "--json",
          "--read-only",
        ]),
      },
    },
  ]
  input.messages.unshift(
    user(maintenanceTaskText(originalTask)),
    ...authoring,
    ...tool(
      "mnt-apply",
      "bash",
      JSON.stringify({
        ok: true,
        verified: true,
        snapshot_id: "new",
        record,
        file_bindings: [
          ...baseline.file_bindings,
          { path: "references/guide.md", page_id: "owned-file", file_id: "stable-file" },
        ],
      }),
    ),
  )
  const wire = JSON.parse(input.entity)
  wire.messages.unshift({ role: "tool", tool_call_id: "mnt-authoring-read", content: original })
  return { ...input, entity: JSON.stringify(wire), authoringBaseline: baseline }
}

test("a split reference reports its original-main occurrence separately without changing raw counts", () => {
  const proof = verifyMaintenanceResource(splitResourceCase())
  assert.equal(proof.raw_complete_body_occurrences, 2)
  assert.equal(proof.contained_old_main?.occurrences, 1)
  assert.equal(proof.contained_old_main?.snapshot_id, "old")
  assert.equal(proof.contained_old_main?.file_id, "main-file")
  assert.equal(proof.current_resource_copies, 1)
  assert.equal(proof.complete_copies, 1)
})

test("old-main attribution rejects changed source, identity, command and unexplained duplicates", () => {
  type Input = ReturnType<typeof splitResourceCase>
  const changeAuthoring = (input: Input, change: (parsed: Record<string, unknown>) => void) => {
    const result = input.messages.find(
      (message) => message.role === "toolResult" && message.toolCallId === "mnt-authoring-read",
    )!
    const parsed = JSON.parse(String(result.content))
    change(parsed)
    result.content = JSON.stringify(parsed)
    const wire = JSON.parse(input.entity)
    wire.messages.find(
      (message: { tool_call_id: string }) => message.tool_call_id === "mnt-authoring-read",
    ).content = result.content
    input.entity = JSON.stringify(wire)
  }
  for (const mutate of [
    (input: Input) =>
      changeAuthoring(input, (value) => {
        value.content += "changed"
      }),
    (input: Input) =>
      changeAuthoring(input, (value) => {
        value.ref = String(value.ref).replace("snapshot=old", "snapshot=wrong")
      }),
    (input: Input) =>
      changeAuthoring(input, (value) => {
        value.snapshot_id = "wrong"
      }),
    (input: Input) => {
      input.authoringBaseline.content += "changed"
    },
    (input: Input) => {
      const message = input.messages.find(
        (value) =>
          value.role === "assistant" &&
          JSON.stringify(value.content).includes("mnt-authoring-read"),
      )!
      message.content = [
        {
          type: "toolCall",
          id: "mnt-authoring-read",
          name: "bash",
          arguments: { command: "forged" },
        },
      ]
    },
    (input: Input) => {
      const wire = JSON.parse(input.entity)
      wire.messages[0].content += "changed"
      input.entity = JSON.stringify(wire)
    },
    (input: Input) => {
      const wire = JSON.parse(input.entity)
      wire.messages.push({ role: "assistant", content: input.observed.bodies[0]![1] })
      input.entity = JSON.stringify(wire)
    },
    (input: Input) => {
      const wire = JSON.parse(input.entity)
      wire.messages.push({
        role: "tool",
        tool_call_id: "unknown-source",
        content: input.observed.bodies[0]![1],
      })
      input.entity = JSON.stringify(wire)
    },
    (input: Input) => {
      const wire = JSON.parse(input.entity)
      const repeat = wire.messages.find(
        (message: { tool_call_id: string }) => message.tool_call_id === "mnt-read-repeat",
      )
      repeat.content = repeat.content.replace("Already available.", input.observed.bodies[0]![1])
      input.entity = JSON.stringify(wire)
    },
  ]) {
    const input = splitResourceCase()
    mutate(input)
    assert.throws(() => verifyMaintenanceResource(input))
  }
})
