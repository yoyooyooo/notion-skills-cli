import { afterAll, expect, test } from "bun:test"
import { mkdtemp, writeFile, access, readFile, realpath } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Effect } from "effect"
import { trashPath } from "../../core/src/local-locks.ts"
import {
  invokeSourceManager,
  sourceManagerBinding,
  type SourceManagerCommand,
} from "../src/source-manager-transport.ts"

const root = await realpath(await mkdtemp(join(tmpdir(), "ntn-source-manager-transport-")))
afterAll(async () => {
  if (process.platform === "darwin") await Effect.runPromise(trashPath(root))
})
const library = "00000000-0000-4000-8000-000000000001"
const executionId = "a".repeat(64)
const input: SourceManagerCommand = {
  version: 1,
  action: "materialize",
  input: {
    version: 1,
    request_id: "fixture-request",
    library,
    purpose: "use",
    target: {
      source_id: "fixture-source",
      member_key: "skills/quoted '$variable' $(literal)",
      expected_skill_id: "fixture-skill",
      registration_digest: "b".repeat(64),
    },
  },
}
async function fixture(body: string) {
  const dir = await mkdtemp(join(root, "case-"))
  const command = join(dir, "manager")
  await writeFile(
    command,
    `#!${process.execPath}\nimport {readFile,writeFile} from "node:fs/promises";\nlet text="";for await(const chunk of process.stdin)text+=chunk;const request=JSON.parse(text);\nconst respond=result=>process.stdout.write(JSON.stringify({version:1,request_id:request.request_id,execution_id:request.execution_id,library:request.library,ok:true,result})+"\\n");\n${body}\n`,
    { mode: 0o700 },
  )
  await writeFile(
    join(dir, "source-manager.json"),
    JSON.stringify({ version: 1, kind: "local", library, execution_id: executionId, command }),
    { mode: 0o600 },
  )
  const options = {
    env: {
      NTN_SKILLS_CONFIG_HOME: dir,
      NOTION_API_TOKEN: "fake-client-secret",
      EXTRA_CLIENT_VALUE: "not-forwarded",
    },
  }
  const binding = await sourceManagerBinding(options)
  if (binding === undefined) throw new Error("missing fixture binding")
  return { dir, command, options, binding }
}
async function eventually(path: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const value = await readFile(path, "utf8")
      if (value !== "") return value
    } catch {}
    await new Promise((done) => setTimeout(done, 10))
  }
  throw new Error("fixture child did not finish")
}

async function eventuallyExited(pid: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return
      throw error
    }
    await new Promise((done) => setTimeout(done, 10))
  }
  throw new Error("fixture child remains alive")
}

test("fixed local manager receives literal JSON and never inherits client credentials or arbitrary env", async () => {
  const f = await fixture(
    "respond({command:request.command,token:process.env.NOTION_API_TOKEN??null,extra:process.env.EXTRA_CLIENT_VALUE??null});",
  )
  expect(await invokeSourceManager(input, f.binding, f.options)).toEqual({
    command: input,
    token: null,
    extra: null,
  })
})

test("manager generation and Library identity are checked without a local fallback", async () => {
  const f = await fixture('request.execution_id="c".repeat(64);respond({ready:true});')
  await expect(invokeSourceManager(input, f.binding, f.options)).rejects.toMatchObject({
    code: "SOURCE_MANAGER_RESPONSE_INVALID",
  })
  await expect(
    invokeSourceManager(
      { ...input, input: { ...input.input, library: "00000000-0000-4000-8000-000000000002" } },
      f.binding,
      f.options,
    ),
  ).rejects.toMatchObject({ code: "SOURCE_MANAGER_SCOPE_MISMATCH" })
})

test("an explicit missing binding and shell-bearing command are rejected before dispatch", async () => {
  await expect(
    sourceManagerBinding({ env: { NTN_SKILLS_SOURCE_MANAGER_BINDING: join(root, "missing") } }),
  ).rejects.toMatchObject({ code: "SOURCE_MANAGER_CONFIG_INVALID" })
  const f = await fixture("respond({ready:true});")
  await writeFile(
    join(f.dir, "source-manager.json"),
    JSON.stringify({ ...f.binding, command: f.command + ";echo injected" }),
    { mode: 0o600 },
  )
  await expect(sourceManagerBinding(f.options)).rejects.toMatchObject({
    code: "SOURCE_MANAGER_CONFIG_INVALID",
  })
})

test("foreground cancellation detaches while the accepted fixed manager finishes its original request", async () => {
  const dir = await mkdtemp(join(root, "detached-"))
  const accepted = join(dir, "accepted"),
    completed = join(dir, "completed"),
    processId = join(dir, "pid")
  const f = await fixture(
    `await writeFile(${JSON.stringify(processId)},String(process.pid));await writeFile(${JSON.stringify(accepted)},request.request_id);await new Promise(done=>setTimeout(done,150));await writeFile(${JSON.stringify(completed)},request.request_id);respond({ready:true});`,
  )
  const controller = new AbortController()
  const waiting = invokeSourceManager(input, f.binding, { ...f.options, signal: controller.signal })
  const outcome = waiting.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  )
  try {
    expect(await eventually(accepted)).toBe("fixture-request")
    controller.abort()
    expect(await outcome).toMatchObject({
      ok: false,
      error: {
        code: "CANCELLED",
        details: { phase: "outcome_unknown", request_id: "fixture-request" },
      },
    })
    expect(await eventually(completed)).toBe("fixture-request")
  } finally {
    controller.abort()
    await outcome
    const pid = Number(await eventually(processId))
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
    await eventuallyExited(pid)
  }
})

test("pre-dispatch cancellation does not start a manager", async () => {
  const dir = await mkdtemp(join(root, "not-dispatched-"))
  const marker = join(dir, "started")
  const f = await fixture(
    `await writeFile(${JSON.stringify(marker)},"started");respond({ready:true});`,
  )
  const controller = new AbortController()
  controller.abort()
  await expect(
    invokeSourceManager(input, f.binding, { ...f.options, signal: controller.signal }),
  ).rejects.toMatchObject({ code: "CANCELLED", details: { phase: "not_dispatched" } })
  await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" })
})
