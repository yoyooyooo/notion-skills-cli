import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { resolveConsumerRuntime } from "./consumer.ts"
import {
  acceptanceFailures,
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
  assert.equal(result.boundaries.real_pi, "1.5.0")
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
