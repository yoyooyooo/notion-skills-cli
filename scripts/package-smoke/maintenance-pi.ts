import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import type { AuthoringContinuation } from "./authoring.ts"
export type { AuthoringContinuation } from "./authoring.ts"

export type MaintenancePiOptions = {
  readonly brokerRoot: string
  readonly brokerPackage: string
  readonly piHost: string
  readonly output: string
  /** Split input directory chosen by main. The selector sees the path only. */
  readonly inputDir: string
  /** Exact current main file. Staged with a readonly CLI read when omitted. */
  readonly currentMainFile?: string
  readonly timeoutMs?: number
  /** Owned Pi package root. When set with a supported executable, skip install. */
  readonly piPackage?: string
}

export type MaintenanceTask = {
  cli: readonly string[]
  target: string
  entry: string
  input_dir: string
  current_main_file: string
}

export type VisibleMessage = {
  role?: string
  content?: unknown
  toolCallId?: string
  toolName?: string
  isError?: boolean
  details?: unknown
}

export type ToolCall = {
  type: "toolCall"
  id: string
  name: string
  arguments: Record<string, unknown>
}

type StepState = "missing" | "ok" | "layout_unsupported" | "stop"
type Chain = "incomplete" | "apply"

export type MaintenanceProgress = {
  steps: { id: string; state: StepState; reason?: string }[]
  chain: Chain
  consumption: "not_run" | "done" | "stopped" | "skipped_not_enabled"
  enabled: boolean
  operationId?: string
  refs: { authoring?: string; applied?: string }
  stopReason?: string
}

const TASK_START = "<mnt08-task>"
const TASK_END = "</mnt08-task>"
const SUPPORTED_PI = ["1.4.0", "1.5.0"] as const
const PINNED_PI = "1.5.0"
const PASSTHROUGH = [
  "NOTION_API_TOKEN",
  "NOTION_API_BASE_URL",
  "NOTION_WORKSPACE_ID",
  "NTN_SKILLS_HOME",
  "NTN_SKILLS_CONFIG_HOME",
  "NTN_SKILLS_CACHE_HOME",
  "NTN_SKILLS_DATA_HOME",
  "NTN_SKILLS_SCHEDULER_ROOT",
  "NTN_SKILLS_NOTION_INTERVAL_MS",
  "NTN_SKILLS_REQUEST_TRACE_LIMIT",
] as const

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      const record = asRecord(part)
      if (!record) return ""
      if (typeof record.text === "string") return record.text
      return textOf(record.content)
    })
    .filter((value) => value.length > 0)
    .join("\n")
}

export function quoteArgv(argv: readonly string[]): string {
  if (argv.length === 0) throw new Error("CLI_ARGV_EMPTY")
  return argv
    .map((value) => {
      if (typeof value !== "string") throw new Error("CLI_ARGV_NOT_STRING")
      return `'${value.replaceAll("'", `'\\''`)}'`
    })
    .join(" ")
}

function endOfObject(text: string, start: number): number | null {
  if (text[start] !== "{") return null
  let depth = 0
  let inString = false
  let escape = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escape) escape = false
      else if (char === "\\") escape = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === "{") depth += 1
    else if (char === "}") {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return null
}

/** One complete non-empty object. A later unclosed `{` is truncation, not a second match. */
export function parseExactlyOneJsonObject(text: string): Record<string, unknown> {
  const found: Record<string, unknown>[] = []
  let index = 0
  while (index < text.length) {
    const start = text.indexOf("{", index)
    if (start < 0) break
    const end = endOfObject(text, start)
    if (end === null) throw new Error("CLI_JSON_TRUNCATED")
    let value: unknown
    try {
      value = JSON.parse(text.slice(start, end))
    } catch {
      throw new Error("CLI_JSON_INVALID")
    }
    const record = asRecord(value)
    if (!record || Object.keys(record).length === 0) throw new Error("CLI_JSON_NOT_MEANINGFUL")
    found.push(record)
    index = end
  }
  if (found.length !== 1)
    throw new Error(found.length === 0 ? "CLI_JSON_MISSING" : "CLI_JSON_NOT_UNIQUE")
  return found[0]!
}

function exitCode(text: string): number {
  const match = /Command exited with code (\d+)/u.exec(text)
  return match ? Number(match[1]) : 0
}

function errorCode(parsed: Record<string, unknown>): string {
  const error = asRecord(parsed.error)
  const code = error?.code ?? parsed.code
  return typeof code === "string" ? code : ""
}

function writesSent(parsed: Record<string, unknown>): boolean | undefined {
  const error = asRecord(parsed.error)
  const details = asRecord(error?.details) ?? asRecord(parsed.details)
  const value = details?.writes_sent
  return typeof value === "boolean" ? value : undefined
}

function operationIdOf(parsed: Record<string, unknown>): string | undefined {
  for (const key of ["apply_operation_id", "body_write_operation_id", "operation_id"]) {
    const value = parsed[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

function refOf(parsed: Record<string, unknown>): string | undefined {
  return typeof parsed.ref === "string" && parsed.ref.length > 0 ? parsed.ref : undefined
}

function enabledOf(parsed: Record<string, unknown>): boolean | undefined {
  if (typeof parsed.enabled === "boolean") return parsed.enabled
  const record = asRecord(parsed.record)
  if (typeof record?.enabled === "boolean") return record.enabled
  return undefined
}

function classifyAudit(parsed: Record<string, unknown>): StepState {
  return parsed.execution === "completed" &&
    parsed.coverage === "full" &&
    asRecord(parsed.severity)?.error === 0 &&
    typeof parsed.run_id === "string" &&
    parsed.run_id.length > 0
    ? "ok"
    : "stop"
}

function classifyDry(parsed: Record<string, unknown>, text: string): StepState {
  const code = errorCode(parsed)
  if (
    code === "SHARED_APPLY_PARTIAL" ||
    code === "SHARED_APPLY_UNRESOLVED" ||
    /PARTIAL|UNKNOWN|UNRESOLVED/u.test(code)
  )
    return "stop"
  if (
    code === "SHARED_APPLY_LAYOUT_BATCH_UNSUPPORTED" ||
    code === "SHARED_APPLY_LAYOUT_UNSUPPORTED"
  )
    return writesSent(parsed) === true ? "stop" : "layout_unsupported"
  if (parsed.ok === false || exitCode(text) !== 0 || parsed.dry_run !== true) return "stop"
  return "ok"
}

function classifyMutation(parsed: Record<string, unknown>, text: string): StepState {
  const code = errorCode(parsed)
  if (
    code === "SHARED_APPLY_PARTIAL" ||
    code === "SHARED_APPLY_UNRESOLVED" ||
    /PARTIAL|UNKNOWN|UNRESOLVED/u.test(code)
  )
    return "stop"
  if (parsed.status === "unknown" || parsed.status === "partial" || parsed.verified === false)
    return "stop"
  if (parsed.ok === false || exitCode(text) !== 0) return "stop"
  if (
    parsed.verified === true &&
    (parsed.status === "applied" || parsed.status === "unchanged" || parsed.action === "unchanged")
  )
    return "ok"
  return "stop"
}

function classifyShow(parsed: Record<string, unknown>, text: string): StepState {
  if (
    parsed.ok === false ||
    exitCode(text) !== 0 ||
    parsed.status === "unknown" ||
    parsed.status === "partial"
  )
    return "stop"
  const next = asRecord(parsed.next)
  const argv = next?.argv
  if (
    !Array.isArray(argv) ||
    argv.length < 2 ||
    argv.some((value) => typeof value !== "string") ||
    argv[0] !== "ntn-skills"
  )
    return "stop"
  return "ok"
}

function classifyReconcile(parsed: Record<string, unknown>, text: string): StepState {
  const code = errorCode(parsed)
  if (
    /PARTIAL|UNKNOWN|UNRESOLVED/u.test(code) ||
    parsed.status === "unknown" ||
    parsed.status === "partial"
  )
    return "stop"
  if (parsed.ok === false || parsed.verified !== true || exitCode(text) !== 0) return "stop"
  return "ok"
}

function resultsById(
  messages: readonly VisibleMessage[],
): Map<string, { text: string; isError: boolean }> {
  const results = new Map<string, { text: string; isError: boolean }>()
  for (const message of messages) {
    if (
      (message.role !== "toolResult" && message.role !== "tool") ||
      typeof message.toolCallId !== "string"
    )
      continue
    const text = textOf(message.content)
    results.set(message.toolCallId, {
      text,
      isError: message.isError === true || exitCode(text) !== 0,
    })
  }
  return results
}

function userText(messages: readonly VisibleMessage[]): string {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => textOf(message.content))
    .join("\n")
}

export function taskFromUserText(text: string): MaintenanceTask {
  const start = text.indexOf(TASK_START)
  const end = start < 0 ? -1 : text.indexOf(TASK_END, start + TASK_START.length)
  if (start < 0 || end < 0) throw new Error("MNT_TASK_NOT_VISIBLE")
  const parsed = parseExactlyOneJsonObject(text.slice(start + TASK_START.length, end))
  for (const key of [
    "body",
    "bodies",
    "content",
    "expected",
    "oracle",
    "source_body",
    "expected_body",
  ]) {
    if (Object.hasOwn(parsed, key)) throw new Error("MNT_TASK_ORACLE_REJECTED")
  }
  const cli = parsed.cli
  if (
    !Array.isArray(cli) ||
    cli.length < 2 ||
    cli.some((value) => typeof value !== "string" || !isAbsolute(value))
  )
    throw new Error("MNT_TASK_CLI_INVALID")
  const field = (key: string) => {
    const value = parsed[key]
    if (typeof value !== "string" || value.length === 0 || /[\r\n]/u.test(value))
      throw new Error("MNT_TASK_FIELD_INVALID")
    return value
  }
  const task: MaintenanceTask = {
    cli: cli.map((value) => {
      if (typeof value !== "string") throw new Error("MNT_TASK_CLI_INVALID")
      return value
    }),
    target: field("target"),
    entry: field("entry"),
    input_dir: field("input_dir"),
    current_main_file: field("current_main_file"),
  }
  if (!isAbsolute(task.input_dir) || !isAbsolute(task.current_main_file))
    throw new Error("MNT_TASK_PATH_INVALID")
  return task
}

export function maintenanceTaskText(task: MaintenanceTask): string {
  const visible = {
    cli: task.cli,
    target: task.target,
    entry: task.entry,
    input_dir: task.input_dir,
    current_main_file: task.current_main_file,
    request:
      "Maintain this owned page with the installed CLI through bash. Copy refs and original operation ids only from previous command JSON. Run a readonly audit and authoring read, then preview the complete apply. Only a supported complete preview permits that same ref and input to be applied once. Inspect the original operation and validate that its next.argv is the same owner's read-only reconcile before running it. If the target is enabled, use the returned fixed ref, select a supporting file from its visible directory, and read that file twice. Stop on unsupported, partial or unknown; do not replace the requested change with another write.",
  }
  return `MNT08 representative maintenance.\n${TASK_START}\n${JSON.stringify(visible)}\n${TASK_END}\n`
}

const bash = (id: string, argv: readonly string[]): ToolCall => ({
  type: "toolCall",
  id,
  name: "bash",
  arguments: { command: quoteArgv(argv), timeout: 180 },
})

function parsedResult(
  results: Map<string, { text: string; isError: boolean }>,
  id: string,
): { parsed?: Record<string, unknown>; text: string; reason?: string } {
  const result = results.get(id)
  if (!result) return { text: "" }
  try {
    return { parsed: parseExactlyOneJsonObject(result.text), text: result.text }
  } catch (error) {
    return {
      text: result.text,
      reason: error instanceof Error ? error.message : "CLI_JSON_INVALID",
    }
  }
}

export function maintenanceProgress(context: {
  messages?: readonly VisibleMessage[]
}): MaintenanceProgress {
  const messages = context.messages ?? []
  const results = resultsById(messages)
  const steps: MaintenanceProgress["steps"] = []
  const push = (id: string, state: StepState, reason?: string) => {
    steps.push(reason ? { id, state, reason } : { id, state })
  }
  let task: MaintenanceTask
  try {
    task = taskFromUserText(userText(messages))
  } catch (error) {
    push("task", "stop", error instanceof Error ? error.message : "MNT_TASK_NOT_VISIBLE")
    return {
      steps,
      chain: "incomplete",
      consumption: "not_run",
      enabled: false,
      refs: {},
      stopReason: "task",
    }
  }
  const audit = parsedResult(results, "mnt-audit")
  if (!results.has("mnt-audit")) push("mnt-audit", "missing")
  else if (!audit.parsed) push("mnt-audit", "stop", audit.reason)
  else push("mnt-audit", classifyAudit(audit.parsed))
  const authoring = parsedResult(results, "mnt-authoring-read")
  if (!results.has("mnt-authoring-read")) push("mnt-authoring-read", "missing")
  else if (!authoring.parsed || !refOf(authoring.parsed))
    push("mnt-authoring-read", "stop", authoring.reason ?? "ref")
  else
    push(
      "mnt-authoring-read",
      authoring.parsed.ok === false || exitCode(authoring.text) !== 0 ? "stop" : "ok",
    )
  const dry = parsedResult(results, "mnt-apply-dry")
  const dryState: StepState = !results.has("mnt-apply-dry")
    ? "missing"
    : !dry.parsed
      ? "stop"
      : classifyDry(dry.parsed, dry.text)
  push("mnt-apply-dry", dryState, dry.reason)
  const mutationId = "mnt-apply"
  const mutation = parsedResult(results, mutationId)
  const mutationState: StepState = !results.has(mutationId)
    ? "missing"
    : !mutation.parsed
      ? "stop"
      : classifyMutation(mutation.parsed, mutation.text)
  push(mutationId, mutationState, mutation.reason)
  const show = parsedResult(results, "mnt-operation-show")
  const showState: StepState = !results.has("mnt-operation-show")
    ? "missing"
    : !show.parsed
      ? "stop"
      : classifyShow(show.parsed, show.text)
  push("mnt-operation-show", showState, show.reason)
  const reconcile = parsedResult(results, "mnt-operation-reconcile")
  const reconcileState: StepState = !results.has("mnt-operation-reconcile")
    ? "missing"
    : !reconcile.parsed
      ? "stop"
      : classifyReconcile(reconcile.parsed, reconcile.text)
  push("mnt-operation-reconcile", reconcileState, reconcile.reason)
  const chain: Chain = mutationState === "ok" ? "apply" : "incomplete"
  const refs = {
    ...(authoring.parsed && refOf(authoring.parsed) ? { authoring: refOf(authoring.parsed) } : {}),
    ...(mutation.parsed && refOf(mutation.parsed) ? { applied: refOf(mutation.parsed) } : {}),
  }
  const enabledFlags = [authoring.parsed, mutation.parsed, reconcile.parsed]
    .map((value) => (value ? enabledOf(value) : undefined))
    .filter((value): value is boolean => value !== undefined)
  const enabled = enabledFlags.at(-1) === true
  const use = results.get("mnt-notion-use")
  const read = results.get("mnt-read")
  const repeat = results.get("mnt-read-repeat")
  let consumption: MaintenanceProgress["consumption"] = "not_run"
  if (!enabled) consumption = reconcileState === "ok" ? "skipped_not_enabled" : "not_run"
  else if (!use || use.isError) consumption = use ? "stopped" : "not_run"
  else if (!read || read.isError) consumption = "stopped"
  else if (!repeat || repeat.isError) consumption = "stopped"
  else consumption = "done"
  if (use) push("mnt-notion-use", use.isError ? "stop" : "ok")
  if (read) push("mnt-read", read.isError ? "stop" : "ok")
  if (repeat) push("mnt-read-repeat", repeat.isError ? "stop" : "ok")
  const operationId = mutation.parsed ? operationIdOf(mutation.parsed) : undefined
  const stop = steps.find((step) => step.state === "stop")
  return {
    steps,
    chain,
    consumption,
    enabled,
    ...(operationId ? { operationId } : {}),
    refs,
    ...(stop ? { stopReason: stop.reason ?? stop.id } : {}),
    ...(task ? {} : {}),
  }
}

export function selectMaintenanceCall(context: {
  messages?: readonly VisibleMessage[]
}): ToolCall | null {
  const messages = context.messages ?? []
  let task: MaintenanceTask
  try {
    task = taskFromUserText(userText(messages))
  } catch (error) {
    const code = error instanceof Error ? error.message : "MNT_TASK_NOT_VISIBLE"
    if (code === "MNT_TASK_ORACLE_REJECTED" || code === "MNT_TASK_NOT_VISIBLE")
      throw new Error(code)
    return null
  }
  const results = resultsById(messages)
  const cli = task.cli
  if (!results.has("mnt-audit"))
    return bash("mnt-audit", [
      ...cli,
      "ctl",
      "audit",
      "run",
      "--target",
      task.target,
      "--entry",
      task.entry,
      "--depth",
      "content",
    ])
  const audit = parsedResult(results, "mnt-audit")
  if (!audit.parsed || classifyAudit(audit.parsed) !== "ok") return null
  if (!results.has("mnt-authoring-read"))
    return bash("mnt-authoring-read", [
      ...cli,
      "read",
      task.target,
      "--database",
      task.entry,
      "--authoring",
      "--json",
      "--read-only",
    ])
  const authoring = parsedResult(results, "mnt-authoring-read")
  const authoringRef = authoring.parsed ? refOf(authoring.parsed) : undefined
  if (
    !authoring.parsed ||
    !authoringRef ||
    authoring.parsed.ok === false ||
    exitCode(authoring.text) !== 0
  )
    return null
  if (!results.has("mnt-apply-dry"))
    return bash("mnt-apply-dry", [
      ...cli,
      "apply",
      authoringRef,
      "--input",
      task.input_dir,
      "--dry-run",
    ])
  const dry = parsedResult(results, "mnt-apply-dry")
  if (!dry.parsed) return null
  const dryState = classifyDry(dry.parsed, dry.text)
  if (dryState === "stop" || dryState === "layout_unsupported") return null
  const mutationId = "mnt-apply"
  if (!results.has(mutationId)) {
    return bash("mnt-apply", [...cli, "apply", authoringRef, "--input", task.input_dir])
  }
  const mutation = parsedResult(results, mutationId)
  if (!mutation.parsed || classifyMutation(mutation.parsed, mutation.text) !== "ok") return null
  const operation = operationIdOf(mutation.parsed)
  if (!operation) return null
  if (!results.has("mnt-operation-show"))
    return bash("mnt-operation-show", [
      ...cli,
      "ctl",
      "operation",
      "show",
      operation,
      "--target",
      task.target,
      "--entry",
      task.entry,
    ])
  const show = parsedResult(results, "mnt-operation-show")
  if (!show.parsed || classifyShow(show.parsed, show.text) !== "ok") return null
  const suggestion = asRecord(show.parsed.next)
  const next = suggestion?.argv
  const expectedNext = [
    "ntn-skills",
    "ctl",
    "operation",
    "reconcile",
    operation,
    "--target",
    task.target,
    "--entry",
    task.entry,
  ]
  if (
    show.parsed.operation_id !== operation ||
    suggestion?.read_only !== true ||
    !Array.isArray(next) ||
    JSON.stringify(next) !== JSON.stringify(expectedNext)
  )
    return null
  if (!results.has("mnt-operation-reconcile"))
    return bash("mnt-operation-reconcile", [...cli, ...expectedNext.slice(1)])
  const reconcile = parsedResult(results, "mnt-operation-reconcile")
  if (!reconcile.parsed || classifyReconcile(reconcile.parsed, reconcile.text) !== "ok") return null
  const flags = [
    enabledOf(authoring.parsed),
    mutation.parsed ? enabledOf(mutation.parsed) : undefined,
    enabledOf(reconcile.parsed),
  ].filter((value): value is boolean => value !== undefined)
  if (flags.at(-1) !== true) return null
  const fixed = (mutation.parsed ? refOf(mutation.parsed) : undefined) ?? authoringRef
  if (!results.has("mnt-notion-use"))
    return {
      type: "toolCall",
      id: "mnt-notion-use",
      name: "notion_use",
      arguments: { ref: fixed, readOnly: true },
    }
  const used = results.get("mnt-notion-use")
  if (!used || used.isError) return null
  const prepared = parseExactlyOneJsonObject(used.text)
  const preparedRecords = Array.isArray(prepared.records) ? prepared.records.map(asRecord) : []
  const files = preparedRecords.flatMap((record) => {
    const values = asRecord(record?.directory)?.files
    return Array.isArray(values) ? values.map(asRecord).filter((value) => value !== undefined) : []
  })
  const changed = asRecord(mutation.parsed.changes)?.files
  const changedPaths = new Set(
    Array.isArray(changed) ? changed.filter((value) => typeof value === "string") : [],
  )
  const supporting = files.filter(
    (file) =>
      typeof file.path === "string" &&
      typeof file.ref === "string" &&
      file.path !== "SKILL.md" &&
      file.path !== "ROUTER.md" &&
      file.path !== "PROMPT.md",
  )
  const resource =
    supporting.find((file) => typeof file.path === "string" && changedPaths.has(file.path)) ??
    supporting[0]
  if (!resource || typeof resource.ref !== "string") return null
  if (!results.has("mnt-read"))
    return { type: "toolCall", id: "mnt-read", name: "read", arguments: { path: resource.ref } }
  const read = results.get("mnt-read")
  if (!read || read.isError) return null
  if (!results.has("mnt-read-repeat"))
    return {
      type: "toolCall",
      id: "mnt-read-repeat",
      name: "read",
      arguments: { path: resource.ref },
    }
  return null
}

const countOf = (haystack: string, needle: string) => {
  if (needle.length === 0) return 0
  let count = 0
  let index = 0
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count += 1
    index += needle.length
  }
  return count
}

export function decodedWireModelText(entity: string) {
  const payload = asRecord(JSON.parse(entity))
  if (!Array.isArray(payload?.messages)) throw new Error("WIRE_MESSAGES_MISSING")
  const leaves = (value: unknown, depth = 0): string[] => {
    if (depth > 64) throw new Error("WIRE_VALUE_DEPTH_LIMIT")
    if (typeof value === "string") return [value]
    if (Array.isArray(value)) return value.flatMap((item) => leaves(item, depth + 1))
    const record = asRecord(value)
    return record ? Object.values(record).flatMap((item) => leaves(item, depth + 1)) : []
  }
  return payload.messages
    .flatMap((message) => {
      const record = asRecord(message)
      if (!record || typeof record.role !== "string") throw new Error("WIRE_MESSAGE_INVALID")
      const text = textOf(record.content)
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return [text]
      }
      return leaves(parsed)
    })
    .join("\n")
}

export function acceptanceFailures(input: {
  toolCalls: { id: string; name: string; resultText: string | null }[]
  http: { entityBytes: number; sseBytes: number }[]
  sessionJsonlBytes: number
  finalRequestText: string | null
  sourceBody: string | null
  directoryPaths: readonly string[]
  finalRequestEntity: string | null
}): string[] {
  const failures: string[] = []
  const executed = input.toolCalls.filter(
    (call) => call.id.length > 0 && call.resultText !== null && call.resultText.length > 0,
  )
  if (executed.length === 0) failures.push("missing_tool_call")
  const ids = executed.map((call) => call.id)
  if (new Set(ids).size !== ids.length) failures.push("tool_call_not_once")
  if (!input.http.length || input.http.some((item) => item.entityBytes <= 0 || item.sseBytes <= 0))
    failures.push("missing_wire_capture")
  if (!(input.sessionJsonlBytes > 0)) failures.push("missing_native_session")
  if (!input.sourceBody || !input.finalRequestText) failures.push("missing_body_source")
  else {
    const bodyCount = countOf(input.finalRequestText, input.sourceBody)
    if (bodyCount !== 1)
      failures.push(bodyCount === 0 ? "missing_body_source" : "body_source_not_unique")
  }
  if (input.directoryPaths.length === 0) failures.push("missing_directory")
  else if (input.finalRequestEntity) {
    const preparedIds = new Set(
      input.toolCalls
        .filter((call) => ["notion_use", "skill_prepare"].includes(call.name))
        .map((call) => call.id),
    )
    const payload = asRecord(JSON.parse(input.finalRequestEntity))
    const messages = Array.isArray(payload?.messages) ? payload.messages.map(asRecord) : []
    const directories: string[][] = []
    for (const message of messages) {
      if (
        message?.role !== "tool" ||
        typeof message.tool_call_id !== "string" ||
        !preparedIds.has(message.tool_call_id)
      )
        continue
      const model = asRecord(JSON.parse(textOf(message.content)))
      if (!Array.isArray(model?.records)) {
        failures.push("missing_directory")
        continue
      }
      for (const value of model.records) {
        const directory = asRecord(asRecord(value)?.directory)
        if (!directory) continue
        if (!Array.isArray(directory.files)) {
          failures.push("missing_directory")
          continue
        }
        const paths = directory.files.map((file) => asRecord(file)?.path)
        if (paths.some((path) => typeof path !== "string")) {
          failures.push("missing_directory")
          continue
        }
        const selected = paths.filter((path): path is string => typeof path === "string")
        if (new Set(selected).size !== selected.length) failures.push("directory_not_unique")
        if (input.directoryPaths.some((path) => selected.includes(path))) directories.push(selected)
      }
    }
    if (
      !directories.length ||
      !input.directoryPaths.every((path) => directories.some((files) => files.includes(path)))
    )
      failures.push("missing_directory")
    if (directories.length > 1) failures.push("directory_not_unique")
  } else {
    failures.push("missing_wire_capture")
  }
  return [...new Set(failures)]
}

function richPlain(value: unknown): string | undefined {
  if (typeof value === "string") return value
  const record = asRecord(value)
  const rich = Array.isArray(value) ? value : record?.rich_text
  if (!Array.isArray(rich)) return undefined
  const text = rich
    .map((part) =>
      typeof asRecord(part)?.plain_text === "string"
        ? String(asRecord(part)?.plain_text)
        : typeof asRecord(asRecord(part)?.text)?.content === "string"
          ? String(asRecord(asRecord(part)?.text)?.content)
          : "",
    )
    .join("")
  return text.length > 0 ? text : undefined
}

export function oracleProjection(
  observed: ReturnType<AuthoringContinuation["observe"]>,
  target: string,
): {
  body?: string
  directoryPaths: string[]
  reason?: string
} {
  const body = observed.bodies.find((pair) => pair[0] === target)?.[1]
  const related = observed.files.filter((file) => {
    const relation = asRecord(asRecord(asRecord(file)?.properties)?.skill)?.relation
    return Array.isArray(relation) && relation.some((item) => asRecord(item)?.id === target)
  })
  const directoryPaths = related
    .map((file) => richPlain(asRecord(asRecord(file)?.properties)?.path))
    .filter((value): value is string => typeof value === "string")
  if (typeof body !== "string" || body.length === 0)
    return { directoryPaths, reason: "oracle_body_missing" }
  if (directoryPaths.length === 0)
    return { body, directoryPaths, reason: "oracle_files_unreadable" }
  return { body, directoryPaths }
}

export function verifyMaintenanceResource(input: {
  messages: readonly VisibleMessage[]
  entity: string
  observed: ReturnType<AuthoringContinuation["observe"]>
  target: string
}) {
  const calls = input.messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.map(asRecord).filter((value) => value?.type === "toolCall")
        : [],
    )
  const results = input.messages.filter((message) => message.role === "toolResult")
  const exactResult = (id: string) => {
    const matching = results.filter((message) => message.toolCallId === id)
    if (matching.length !== 1 || matching[0]?.isError)
      throw new Error("MNT_RESOURCE_RESULT_MISSING")
    return matching[0]!
  }
  const readCalls = ["mnt-read", "mnt-read-repeat"].map((id) => {
    const matches = calls.filter((call) => call?.id === id)
    if (matches.length !== 1 || matches[0]?.name !== "read")
      throw new Error("MNT_RESOURCE_CALL_NOT_ONCE")
    const path = asRecord(matches[0].arguments)?.path
    if (typeof path !== "string") throw new Error("MNT_RESOURCE_REF_MISSING")
    return path
  })
  if (readCalls[0] !== readCalls[1]) throw new Error("MNT_RESOURCE_REPEAT_CHANGED")
  const prepared = parseExactlyOneJsonObject(textOf(exactResult("mnt-notion-use").content))
  const directory = (Array.isArray(prepared.records) ? prepared.records.map(asRecord) : [])
    .flatMap((record) => {
      const files = asRecord(record?.directory)?.files
      return Array.isArray(files) ? files.map(asRecord) : []
    })
    .filter((file) => file?.ref === readCalls[0])
  if (
    directory.length !== 1 ||
    typeof directory[0]?.path !== "string" ||
    directory[0].path === "SKILL.md"
  )
    throw new Error("MNT_RESOURCE_NOT_DISCOVERED")
  const path = directory[0].path
  const rows = input.observed.files.map(asRecord).filter((row) => {
    const properties = asRecord(row?.properties),
      relation = asRecord(properties?.skill)?.relation
    return (
      richPlain(properties?.path) === path &&
      Array.isArray(relation) &&
      relation.length === 1 &&
      asRecord(relation[0])?.id === input.target
    )
  })
  if (rows.length !== 1 || typeof rows[0]?.id !== "string")
    throw new Error("MNT_RESOURCE_OWNER_AMBIGUOUS")
  const body = input.observed.bodies.find((pair) => pair[0] === rows[0]!.id)?.[1]
  if (!body) throw new Error("MNT_RESOURCE_SOURCE_MISSING")
  const payload = asRecord(JSON.parse(input.entity))
  if (!Array.isArray(payload?.messages)) throw new Error("WIRE_MESSAGES_MISSING")
  const projected = payload.messages.map(asRecord).filter((message) => message?.role === "tool")
  const outcomes = ["mnt-read", "mnt-read-repeat"].map((id, index) => {
    const original = exactResult(id),
      text = textOf(original.content)
    if (!text.startsWith(body)) throw new Error("MNT_RESOURCE_ORIGINAL_INCOMPLETE")
    const effects = asRecord(asRecord(original.details)?.effects)
    if (
      !effects ||
      effects.version !== 1 ||
      !["none", "retained", "unknown"].includes(String(effects.remote_writes))
    )
      throw new Error("MNT_RESOURCE_EFFECTS_UNBOUND")
    const footer = "\n\n<notion-effects>" + JSON.stringify(effects) + "</notion-effects>"
    const suffix = text.slice(body.length)
    if (suffix !== footer && suffix !== "\n" + footer) throw new Error("MNT_RESOURCE_EXTRA_CONTENT")
    const found = projected.filter((message) => message?.tool_call_id === id)
    if (
      found.length !== 1 ||
      textOf(found[0]?.content) !== (index === 0 ? body : "Already available.") + suffix
    )
      throw new Error("MNT_RESOURCE_PROJECTION_OR_EFFECTS_CHANGED")
    return {
      tool_call_id: id,
      remote_writes: effects.remote_writes,
      author_content: effects.author_content,
      original_sha256: hash(text),
      model_sha256: hash(textOf(found[0]?.content)),
    }
  })
  if (countOf(decodedWireModelText(input.entity), body) !== 1)
    throw new Error("MNT_RESOURCE_BODY_NOT_UNIQUE")
  return {
    path,
    page_id: rows[0].id,
    file_id: richPlain(asRecord(rows[0].properties)?.file_id),
    source_sha256: hash(body),
    source_bytes: Buffer.byteLength(body),
    complete_copies: 1,
    original_full_results: 2,
    effects: outcomes,
  }
}

async function runCaptured(
  file: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      setTimeout(() => child.kill("SIGKILL"), 2000).unref()
    }, timeoutMs)
    child.stdout.on("data", (chunk) => stdout.push(chunk))
    child.stderr.on("data", (chunk) => stderr.push(chunk))
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code !== 0)
        reject(
          new Error(
            `${file} exited ${code}: ${Buffer.concat(stderr).toString("utf8").slice(0, 500)}`,
          ),
        )
      else resolvePromise({ stdout: Buffer.concat(stdout).toString("utf8"), code })
    })
  })
}

async function resolveOwnedPi(
  broker: {
    resolveHost: (
      host: string,
    ) => Promise<{ file: string; prefix: string[]; path: string; identity: string }>
    supported: readonly string[]
  },
  options: MaintenancePiOptions,
): Promise<{
  executable: string
  version: string
  packageRoot: string
  ownedInstall: boolean
  requested: string
}> {
  const requested = await broker.resolveHost(options.piHost)
  const requestedVersion = (
    await runCaptured(requested.file, [...requested.prefix, "--version"], options.output, 30_000)
  ).stdout.trim()
  if (
    (SUPPORTED_PI as readonly string[]).includes(requestedVersion) &&
    broker.supported.includes(requestedVersion)
  ) {
    const packageRoot = await owningPackage(options.piPackage ?? dirname(requested.identity))
    return {
      executable: requested.path,
      version: requestedVersion,
      packageRoot,
      ownedInstall: false,
      requested: requestedVersion,
    }
  }
  const prefix = join(options.output, "owned-pi")
  await mkdir(prefix, { recursive: true })
  const bin = join(prefix, "node_modules", ".bin", "pi")
  let installed = ""
  try {
    installed = (await runCaptured(bin, ["--version"], prefix, 30_000)).stdout.trim()
  } catch {
    installed = ""
  }
  if (installed !== PINNED_PI) {
    await runCaptured(
      "npm",
      [
        "install",
        "--prefix",
        prefix,
        "--no-fund",
        "--no-audit",
        "--omit=optional",
        `@earendil-works/pi-coding-agent@${PINNED_PI}`,
      ],
      prefix,
      180_000,
    )
    installed = (await runCaptured(bin, ["--version"], prefix, 30_000)).stdout.trim()
  }
  if (installed !== PINNED_PI) throw new Error(`OWNED_PI_VERSION_${installed || "missing"}`)
  const resolved = await broker.resolveHost(bin)
  return {
    executable: resolved.path,
    version: installed,
    packageRoot: await owningPackage(dirname(resolved.identity)),
    ownedInstall: true,
    requested: requestedVersion,
  }
}

async function owningPackage(start: string): Promise<string> {
  let current = resolve(start)
  for (;;) {
    try {
      const info = JSON.parse(await readFile(join(current, "package.json"), "utf8")) as {
        name?: string
      }
      if (info.name === "@earendil-works/pi-coding-agent") return current
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    const parent = dirname(current)
    if (parent === current) throw new Error("PI_PACKAGE_NOT_FOUND")
    current = parent
  }
}

async function filesUnder(directory: string): Promise<string[]> {
  const found: string[] = []
  const visit = async (current: string) => {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) await visit(path)
      else found.push(path)
    }
  }
  await visit(directory)
  return found
}

function assertLoopback(value: string | undefined): string {
  let url: URL
  try {
    url = new URL(String(value))
  } catch {
    throw new Error("NOTION_BASE_NOT_LOOPBACK")
  }
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost"))
    throw new Error("NOTION_BASE_NOT_LOOPBACK")
  return url.origin
}

type BrokerModules = {
  startRpc: (options: Record<string, unknown>) => Promise<{
    prompt: (message: string) => Promise<unknown>
    stop: () => Promise<void>
    closeInput: () => Promise<void>
    frames: unknown[]
    lifecycle: { event: string; pid?: number; code?: number | null; signal?: string | null }[]
  }>
  isolatedEnv: (options: Record<string, string>) => Record<string, string>
  resolveHost: (
    host: string,
  ) => Promise<{ file: string; prefix: string[]; path: string; identity: string }>
  supportedPiVersions: readonly string[]
  startLoopbackMock: (options: Record<string, unknown>) => Promise<{
    baseUrl: string
    requests: {
      phase?: string
      bytes?: number
      sse?: string[]
      call?: { id?: string; name?: string } | null
      entityFile?: string
    }[]
    close: () => Promise<void>
  }>
  renderHttpWrapper: (options: { helperUrl: string; serializerUrl: string }) => string
  httpBaseUrlEnv: string
  fixtureModelId: string
  resolveInstalledPiSerializer: (
    packageRoot: string,
    version: string,
  ) => Promise<{ serializer: { path: string; sha256: string } }>
  contextFromCompletionRequest: (body: unknown) => { messages: VisibleMessage[] }
}

async function loadBroker(brokerRoot: string): Promise<BrokerModules> {
  const root = resolve(brokerRoot)
  const url = (path: string) => pathToFileURL(join(root, path)).href
  const [harness, fixture, mock, sdk] = await Promise.all([
    import(url("packages/context-broker/scripts/context-broker-rpc-harness.mjs")),
    import(url("packages/context-broker/scripts/context-broker-e2e-fixture.mjs")),
    import(url("scripts/mock-provider-adapter.mjs")),
    import(url("scripts/notion-sdk-pi.mjs")),
  ])
  return {
    startRpc: harness.startRpc,
    isolatedEnv: fixture.isolatedEnv,
    resolveHost: fixture.resolveHost,
    supportedPiVersions: fixture.supportedPiVersions,
    startLoopbackMock: mock.startLoopbackMock,
    renderHttpWrapper: mock.renderHttpWrapper,
    httpBaseUrlEnv: mock.httpBaseUrlEnv,
    fixtureModelId: mock.fixtureModelId,
    resolveInstalledPiSerializer: sdk.resolveInstalledPiSerializer,
    contextFromCompletionRequest: mock.contextFromCompletionRequest,
  }
}

async function extensionFrom(brokerPackage: string): Promise<string> {
  const candidates = [brokerPackage, join(brokerPackage, "packages/context-broker")]
  for (const candidate of candidates) {
    try {
      const manifest = JSON.parse(await readFile(join(candidate, "package.json"), "utf8")) as {
        pi?: { extensions?: string[] }
      }
      const relative = manifest.pi?.extensions?.[0]
      if (relative) return resolve(candidate, relative)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  throw new Error("BROKER_EXTENSION_NOT_FOUND")
}

const saveJson = (path: string, value: unknown) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })

export async function checkPinsOutsideMock(
  input: AuthoringContinuation,
  progress: MaintenanceProgress,
  authoringJson: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const authoringRef = refOf(authoringJson)
  const authoringBody = authoringJson.content
  if (!authoringRef || typeof authoringBody !== "string")
    return { status: "not_run", reason: "authoring_result_missing" }
  const old = asRecord(
    await input.noWrites("mnt-pi-old-pin", ["read", authoringRef, "--json", "--read-only"]),
  )
  const oldBody = old?.content
  const report: Record<string, unknown> = {
    status: oldBody === authoringBody ? "preserved" : "failed",
    old_pin: authoringRef,
    old_pin_sha256: typeof oldBody === "string" ? hash(oldBody) : null,
    authoring_sha256: hash(authoringBody),
    oracle_used_for_selection: false,
  }
  if (progress.refs.applied && progress.refs.applied !== authoringRef) {
    const fresh = asRecord(
      await input.noWrites("mnt-pi-new-pin", [
        "read",
        progress.refs.applied,
        "--json",
        "--read-only",
      ]),
    )
    report.new_pin = progress.refs.applied
    report.new_pin_sha256 = typeof fresh?.content === "string" ? hash(fresh.content) : null
    report.new_pin_differs = fresh?.content !== authoringBody
    const oldLocation = new URL(authoringRef),
      newLocation = new URL(progress.refs.applied)
    const currentBody = input.observe().bodies.find((pair) => pair[0] === input.target)?.[1]
    if (
      oldLocation.hostname !== newLocation.hostname ||
      oldLocation.pathname !== newLocation.pathname ||
      oldLocation.searchParams.get("snapshot") === newLocation.searchParams.get("snapshot") ||
      fresh?.has_more !== false ||
      fresh?.content === authoringBody ||
      typeof fresh?.content !== "string" ||
      typeof currentBody !== "string" ||
      countOf(fresh.content, currentBody) !== 1
    )
      report.status = "failed"
  } else {
    report.status = "failed"
  }
  const oracle = input.observe().bodies.find((pair) => pair[0] === input.target)?.[1]
  report.oracle_body_sha256 = typeof oracle === "string" ? hash(oracle) : null
  return report
}

export async function runMaintenancePi(
  input: AuthoringContinuation,
  options: MaintenancePiOptions,
): Promise<Record<string, unknown>> {
  const output = resolve(options.output)
  await mkdir(output, { recursive: true })
  const notionOrigin = assertLoopback(input.env.NOTION_API_BASE_URL)
  const broker = await loadBroker(options.brokerRoot)
  const extension = await extensionFrom(options.brokerPackage)
  const pi = await resolveOwnedPi(
    { resolveHost: broker.resolveHost, supported: broker.supportedPiVersions },
    { ...options, output },
  )
  const serializer = await broker.resolveInstalledPiSerializer(pi.packageRoot, pi.version)
  const currentMain = options.currentMainFile ?? join(output, "current-main.md")
  let staged: { sha256: string; bytes: number } | undefined
  if (!options.currentMainFile) {
    const read = asRecord(
      await input.noWrites("mnt-pi-stage-current-main", [
        "read",
        input.target,
        "--database",
        input.database,
        "--authoring",
        "--json",
        "--read-only",
      ]),
    )
    if (typeof read?.content !== "string" || read.content.length === 0)
      throw new Error("CURRENT_MAIN_UNREADABLE")
    await writeFile(currentMain, read.content, { mode: 0o600 })
    staged = { sha256: hash(read.content), bytes: Buffer.byteLength(read.content) }
  }
  const task: MaintenanceTask = {
    cli: [input.context.runtime, input.context.executable],
    target: input.target,
    entry: input.database,
    input_dir: resolve(options.inputDir),
    current_main_file: resolve(currentMain),
  }
  for (const path of task.cli) if (!isAbsolute(path)) throw new Error("CLI_PATH_NOT_ABSOLUTE")
  const prompt = maintenanceTaskText(task)
  const home = join(output, "pi-home")
  const agentDir = join(home, "agent")
  const sessions = join(output, "sessions")
  const providerPath = join(home, "fake-provider.mjs")
  await mkdir(join(agentDir, "context-broker"), { recursive: true })
  await mkdir(sessions, { recursive: true })
  const config = join(agentDir, "context-broker/config.yml")
  await saveJson(config, {
    sources: [
      {
        type: "notion",
        id: "mnt08",
        namespace: "mnt08",
        database: input.database,
        command: [...task.cli],
        cacheDir: join(home, "broker-cache"),
        prefetch: false,
      },
    ],
  })
  await saveJson(join(agentDir, "settings.json"), {
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
  })
  const helperUrl = pathToFileURL(
    join(resolve(options.brokerRoot), "scripts/mock-provider-adapter.mjs"),
  ).href
  await writeFile(
    providerPath,
    broker.renderHttpWrapper({
      helperUrl,
      serializerUrl: pathToFileURL(serializer.serializer.path).href,
    }),
    { mode: 0o600 },
  )
  const bodyDir = join(output, "http-bodies")
  const sseDir = join(output, "http-sse")
  await mkdir(bodyDir, { mode: 0o700 })
  await mkdir(sseDir, { mode: 0o700 })
  let bodyCount = 0
  const server = await broker.startLoopbackMock({
    selectCall: (context: { messages?: VisibleMessage[] }) => selectMaintenanceCall(context),
    onBody: async (record: { entityFile?: string; entityBytes?: number }, body: Buffer) => {
      const name = `${String(++bodyCount).padStart(3, "0")}.bin`
      await writeFile(join(bodyDir, name), body, { mode: 0o600, flag: "wx" })
      record.entityFile = name
      record.entityBytes = body.length
    },
    limits: {
      maxRequests: 16,
      maxBodyBytes: 16 * 1024 * 1024,
      requestTimeoutMs: 30_000,
      holdTimeoutMs: 120_000,
      maxInFlight: 1,
    },
  })
  const envOverrides: Record<string, string> = {
    base: home,
    agentDir,
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    CONTEXT_BROKER_HOST: "pi",
    CONTEXT_BROKER_CONFIG: config,
    [broker.httpBaseUrlEnv]: server.baseUrl,
  }
  for (const key of PASSTHROUGH) {
    const value = input.env[key]
    if (value !== undefined) envOverrides[key] = value
  }
  // The source service retains the complete actual HTTP ledger; model-visible CLI
  // output needs totals, not an echo of the private transport trace.
  envOverrides.NTN_SKILLS_REQUEST_TRACE_LIMIT = "0"
  const env = broker.isolatedEnv(envOverrides)
  const argv = [
    "--no-extensions",
    "--no-skills",
    "--no-mcp",
    "--session-dir",
    sessions,
    "--tools",
    "bash,read,notion_list,notion_use",
    "-e",
    providerPath,
    "-e",
    extension,
    "--model",
    `context-broker-e2e/${broker.fixtureModelId}`,
  ]
  await saveJson(join(output, "launch.json"), {
    pi: {
      executable: pi.executable,
      version: pi.version,
      requested: pi.requested,
      owned_install: pi.ownedInstall,
      package: pi.packageRoot,
    },
    serializer: { path: serializer.serializer.path, sha256: serializer.serializer.sha256 },
    broker_extension: extension,
    notion_origin: notionOrigin,
    argv,
    cwd: home,
    env_keys: Object.keys(env).sort(),
    staged_current_main: staged ?? {
      path: task.current_main_file,
      content: "caller-supplied-file",
    },
    boundaries: {
      controlled_http: true,
      real_pi: true,
      serializer: "installed-pi-ai",
      real_notion: false,
      real_model: false,
    },
  })
  let rpc: Awaited<ReturnType<BrokerModules["startRpc"]>> | undefined
  let promptError: string | undefined
  let result: Record<string, unknown> = { status: "failed", stop_reason: "not_finished" }
  try {
    try {
      rpc = await broker.startRpc({
        host: pi.executable,
        args: argv,
        cwd: home,
        env,
        timeoutMs: options.timeoutMs ?? 120_000,
      })
      try {
        await rpc.prompt(prompt)
        await rpc.closeInput()
      } catch (error) {
        promptError = error instanceof Error ? error.message : String(error)
        await rpc.stop().catch(() => undefined)
      }
    } catch (error) {
      promptError = error instanceof Error ? error.message : String(error)
      if (rpc) await rpc.stop().catch(() => undefined)
    }
    for (const [index, request] of server.requests.entries()) {
      if (request.sse)
        await writeFile(
          join(sseDir, `${String(index + 1).padStart(3, "0")}.sse`),
          request.sse.join(""),
          { mode: 0o600 },
        )
    }
    const sessionFiles = (await filesUnder(sessions)).filter((path) => path.endsWith(".jsonl"))
    const sessionSummaries: { path: string; bytes: number; sha256: string; parse_error?: true }[] =
      []
    const sessionMessages: VisibleMessage[] = []
    for (const path of sessionFiles) {
      const bytes = await readFile(path)
      const summary: { path: string; bytes: number; sha256: string; parse_error?: true } = {
        path,
        bytes: bytes.length,
        sha256: hash(bytes),
      }
      sessionSummaries.push(summary)
      for (const line of bytes.toString("utf8").split("\n")) {
        if (!line.trim()) continue
        try {
          const message = messageFromSessionLine(JSON.parse(line))
          if (message) sessionMessages.push(message)
        } catch {
          summary.parse_error = true
        }
      }
    }
    const contexts = []
    for (const request of server.requests) {
      if (!request.entityFile) continue
      const body = await readFile(join(bodyDir, request.entityFile))
      try {
        contexts.push(broker.contextFromCompletionRequest(JSON.parse(body.toString("utf8"))))
      } catch {
        contexts.push(undefined)
      }
    }
    const lastContext = contexts.findLast((context) => context)
    const transcript = sessionMessages.length > 0 ? sessionMessages : (lastContext?.messages ?? [])
    const progress = maintenanceProgress({ messages: transcript })
    const toolCalls = toolCallsFrom(sessionMessages)
    const finalRequest = [...server.requests].reverse().find((request) => request.entityFile)
    const finalEntity = finalRequest?.entityFile
      ? await readFile(join(bodyDir, finalRequest.entityFile), "utf8")
      : null
    const finalText = finalEntity ? decodedWireModelText(finalEntity) : null
    let oracle: ReturnType<typeof oracleProjection>
    try {
      oracle = oracleProjection(input.observe(), input.target)
    } catch (error) {
      oracle = {
        directoryPaths: [],
        reason: error instanceof Error ? error.message : "oracle_failed",
      }
    }
    const acceptance = acceptanceFailures({
      toolCalls,
      http: server.requests.map((request) => ({
        entityBytes: request.entityFile ? (request.bytes ?? 1) : 0,
        sseBytes: request.sse?.join("").length ?? 0,
      })),
      sessionJsonlBytes: sessionSummaries.reduce((sum, item) => sum + item.bytes, 0),
      finalRequestText: finalText,
      sourceBody: oracle.body ?? null,
      directoryPaths: oracle.directoryPaths,
      finalRequestEntity: finalEntity,
    })
    let resource: Record<string, unknown>
    try {
      if (!finalEntity) throw new Error("WIRE_MESSAGES_MISSING")
      resource = {
        status: "passed",
        ...verifyMaintenanceResource({
          messages: sessionMessages,
          entity: finalEntity,
          observed: input.observe(),
          target: input.target,
        }),
      }
    } catch (error) {
      resource = {
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      }
      acceptance.push("resource_source_or_effects_invalid")
    }
    let pins: Record<string, unknown> = { status: "not_run" }
    const authoringResult = resultsById(transcript).get("mnt-authoring-read")
    if (authoringResult && progress.chain !== "incomplete") {
      try {
        pins = await checkPinsOutsideMock(
          input,
          progress,
          parseExactlyOneJsonObject(authoringResult.text),
        )
      } catch (error) {
        pins = { status: "failed", reason: error instanceof Error ? error.message : String(error) }
      }
    }
    const passed =
      acceptance.length === 0 &&
      progress.chain === "apply" &&
      progress.consumption === "done" &&
      pins.status === "preserved" &&
      !promptError &&
      !oracle.reason &&
      sessionSummaries.length > 0 &&
      sessionSummaries.every((value) => !value.parse_error) &&
      server.requests.length > 0 &&
      server.requests.every(
        (request) =>
          request.entityFile &&
          (request.bytes ?? 0) > 0 &&
          request.phase === "responded" &&
          request.sse?.join("").includes("data: [DONE]"),
      ) &&
      (rpc?.frames ?? []).some((frame) => asRecord(frame)?.type === "agent_end")
    result = {
      status: passed ? "passed" : "failed",
      chain: progress.chain,
      consumption: progress.consumption,
      split_applied: progress.chain === "apply",
      stop_reason: progress.stopReason ?? promptError ?? oracle.reason ?? null,
      acceptance,
      pins,
      resource,
      oracle: oracle.reason ?? "posthoc_only",
      tool_calls: toolCalls.map((call) => ({
        id: call.id,
        name: call.name,
        result_sha256: call.resultText ? hash(call.resultText) : null,
      })),
      session_steps: progress.steps,
      http: server.requests.map((request) => ({
        phase: request.phase ?? null,
        entity: request.entityFile ?? null,
        bytes: request.bytes ?? null,
        sse_bytes: request.sse?.join("").length ?? 0,
        call: request.call
          ? { id: request.call.id ?? null, name: request.call.name ?? null }
          : null,
      })),
      sessions: sessionSummaries,
      finality: {
        prompt_error: promptError ?? null,
        lifecycle: rpc?.lifecycle ?? [],
        frame_count: rpc?.frames.length ?? 0,
        agent_end: (rpc?.frames ?? []).some((frame) => asRecord(frame)?.type === "agent_end"),
      },
      boundaries: {
        controlled_http: true,
        installed_cli: task.cli[1],
        real_pi: pi.version,
        serializer: serializer.serializer.sha256,
        real_notion: false,
        real_model: false,
      },
    }
    await saveJson(join(output, "result.json"), result)
    await saveJson(join(output, "rpc-lifecycle.json"), rpc?.lifecycle ?? [])
    if (rpc)
      await saveJson(
        join(output, "rpc-frames.json"),
        rpc.frames.map((frame) => summarizeFrame(frame)),
      )
  } finally {
    await server.close()
  }
  if (result.status !== "passed") throw new Error(`MNT08_PI_${String(result.status)}:${output}`)
  return result
}

function messageFromSessionLine(value: unknown): VisibleMessage | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const message = asRecord(record.message) ?? (typeof record.role === "string" ? record : undefined)
  if (!message || typeof message.role !== "string") return undefined
  return message as VisibleMessage
}

export function toolCallsFrom(
  messages: readonly VisibleMessage[],
): { id: string; name: string; resultText: string | null }[] {
  const calls: { id: string; name: string }[] = []
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      const record = asRecord(block)
      if (
        record?.type === "toolCall" &&
        typeof record.id === "string" &&
        typeof record.name === "string"
      )
        calls.push({ id: record.id, name: record.name })
    }
  }
  const results = resultsById(messages)
  return calls.map((call) => ({ ...call, resultText: results.get(call.id)?.text ?? null }))
}

function summarizeFrame(frame: unknown): unknown {
  const record = asRecord(frame)
  if (!record) return { type: null }
  return {
    type: record.type ?? null,
    id: record.id ?? null,
    success: record.success ?? null,
    stopReason: asRecord(record.message)?.stopReason ?? null,
  }
}
