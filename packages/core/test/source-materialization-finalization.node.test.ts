import { ConfigProvider, Effect } from "effect"
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, test, vi } from "vitest"
import { materializeSource } from "../../cli/src/management.ts"
import * as operationRuntime from "../../cli/src/operation-runtime.ts"
import { nodeRuntime } from "../../cli/src/runtime.ts"
import { authScope } from "../src/catalog.ts"
import { property, SkillsError } from "../src/model.ts"
import { sharedRecordFromPage } from "../src/shared-content.ts"
import {
  decodeSourceMaterializationReceipt,
  type SourceMaterializationRequest,
  type SourceMaterializationReceipt,
} from "../src/shared-source-materialization-model.ts"
import { librarySchemaResponse } from "./library-schema-fixture.ts"
import {
  currentId,
  currentLibrary as library,
  currentSnapshotFixture,
} from "./shared-current-fixture.ts"

const { startSdkSourceFixture } = await import(
  new URL("../../../scripts/sdk-source-fixture.mjs", import.meta.url).href
)
const executionId = "a".repeat(64)
const managerScope = "b".repeat(64)
const request: SourceMaterializationRequest = {
  version: 1,
  request_id: "explicit-member-finalization",
  library: library.library_id,
  purpose: "use",
  target: {
    source_id: "registered-source",
    member_key: "skills/demo",
    expected_skill_id: "demo",
    registration_digest: "c".repeat(64),
  },
  authorization_root: {
    skill_id: "author-root",
    page_id: currentId(70),
    requires_digest: "d".repeat(64),
  },
}

async function setup(changeReply?: (reply: Record<string, unknown>) => void) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "source-finalization-"))
  const f = currentSnapshotFixture({ fileCount: 0 })
  const main = {
    ...structuredClone(f.main),
    parent: { ...f.main.parent, database_id: library.skills.database_id },
  }
  const source = await startSdkSourceFixture(
    {
      notion: {
        library,
        root: librarySchemaResponse("v1/pages/" + library.library_id, library),
        root_children: property(
          librarySchemaResponse("v1/blocks/" + library.library_id + "/children", library),
        ).results,
        databases: (["skills", "files", "records", "sources"] as const).map((role) =>
          librarySchemaResponse("v1/databases/" + library[role].database_id, library),
        ),
        data_sources: (["skills", "files", "records", "sources"] as const).map((role) =>
          librarySchemaResponse("v1/data_sources/" + library[role].data_source_id, library),
        ),
        main,
        skills: [main],
        files: [],
        records: [],
        sources: [],
        bodies: Object.fromEntries(f.bodies),
      },
    },
    join(root, "http.jsonl"),
  )
  const receipt: SourceMaterializationReceipt = decodeSourceMaterializationReceipt({
    version: 1,
    request_id: request.request_id,
    library_id: library.library_id,
    scope: managerScope,
    target: request.target,
    authorization_root: request.authorization_root,
    status: "ready",
    operation_id: "fixed-manager-operation",
    records: [
      sharedRecordFromPage(
        main,
        {
          alias: "controlled",
          title: "Controlled Library",
          database_id: library.skills.database_id,
          data_source_ids: [library.skills.data_source_id],
          role: "content",
          shared_library: library,
        },
        library.skills.data_source_id,
      ),
    ],
    affected_skill_ids: [request.target.expected_skill_id],
    source_revisions: [{ source_id: request.target.source_id, revision: "e".repeat(64) }],
    effects: { remote_writes: "management", projection: "none" },
  })
  const reply: Record<string, unknown> = {
    version: 1,
    request_id: request.request_id,
    execution_id: executionId,
    library: library.library_id,
    ok: true,
    result: receipt,
  }
  changeReply?.(reply)
  const config = join(root, "config")
  await mkdir(config)
  const command = join(root, "manager.mjs")
  const managerInput = join(root, "manager-input.json")
  const managerOutput = join(root, "manager-output.json")
  const managerExit = join(root, "manager-exit.json")
  await writeFile(
    command,
    `#!${process.execPath}
import fs from 'node:fs';
let text='';for await(const chunk of process.stdin)text+=chunk;
fs.writeFileSync(${JSON.stringify(managerInput)},JSON.stringify({pid:process.pid,request:JSON.parse(text)}));
const reply=${JSON.stringify(reply)};
fs.writeFileSync(${JSON.stringify(managerOutput)},JSON.stringify(reply));
process.once('exit',code=>fs.writeFileSync(${JSON.stringify(managerExit)},JSON.stringify({pid:process.pid,code})));
process.stdout.write(JSON.stringify(reply)+'\\n');
`,
    { mode: 0o700 },
  )
  await writeFile(
    join(config, "source-manager.json"),
    JSON.stringify({
      version: 1,
      kind: "local",
      library: library.library_id,
      execution_id: executionId,
      command,
    }),
    { mode: 0o600 },
  )
  const env = {
    NOTION_API_TOKEN: "controlled-consumer-token",
    NOTION_API_BASE_URL: source.origin,
    NTN_SKILLS_HOME: join(root, "state"),
    NTN_SKILLS_CONFIG_HOME: config,
    NTN_SKILLS_CACHE_HOME: join(root, "cache"),
    NTN_SKILLS_SCHEDULER_ROOT: join(root, "scheduler"),
    NTN_SKILLS_NOTION_INTERVAL_MS: "100",
  }
  // Only authenticate the synthetic endpoint to establish this test Store's scope.
  // No target catalog or body is read before the management call.
  const consumerScope = await Effect.runPromise(
    authScope.pipe(
      Effect.provide(nodeRuntime(root, env).live),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
      Effect.scoped,
    ),
  )
  const options = { cwd: root, library: library.library_id, env }
  const baselineHttp = source.requests.length
  const verified = {
    request_id: request.request_id,
    execution_id: executionId,
    library: library.library_id,
    receipt: reply.result,
  }
  const managerCompleted = async () => {
    const input = JSON.parse(await readFile(managerInput, "utf8"))
    const output = JSON.parse(await readFile(managerOutput, "utf8"))
    const exit = JSON.parse(await readFile(managerExit, "utf8"))
    expect(input.request.command).toEqual({ version: 1, action: "materialize", input: request })
    expect(output).toEqual(reply)
    expect(exit).toEqual({ pid: input.pid, code: 0 })
  }
  return {
    root,
    source,
    receipt,
    reply,
    verified,
    options,
    consumerScope,
    baselineHttp,
    managerCompleted,
    managerInput,
  }
}

type Fixture = Awaited<ReturnType<typeof setup>>
async function failed(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(SkillsError)
    if (!(error instanceof SkillsError)) throw error
    return error
  }
  throw new Error("Consumer finalization must remain failed")
}
async function finish(f: Fixture) {
  await f.source.close()
  expect(f.source.unexpected).toEqual([])
  expect(
    f.source.requests.some((row: { semantic_write?: boolean }) => row.semantic_write === true),
  ).toBe(false)
  console.info(JSON.stringify({ sourceFinalizationEvidence: f.root }))
}
function assertVerified(error: SkillsError, f: Fixture) {
  expect(error.details).toMatchObject({
    phase: "consumer_finalization",
    local_error_code: error.code,
    verified_management: f.verified,
  })
  const retained = property(property(error.details).verified_management).receipt
  expect(retained).toEqual(f.reply.result)
  expect(property(retained).scope).toBe(managerScope)
  expect(property(retained).scope).not.toBe(f.consumerScope)
}

test("public management preserves a verified ready receipt when local invalidation fails", async () => {
  const f = await setup()
  try {
    const db = new DatabaseSync(join(f.options.env.NTN_SKILLS_HOME, "state.sqlite"))
    try {
      db.prepare("INSERT INTO catalogs(scope,selection,generation,payload) VALUES(?,?,1,?)").run(
        f.consumerScope,
        "broken-local-json",
        "{",
      )
    } finally {
      db.close()
    }
    const error = await failed(materializeSource(request, f.options))
    expect(error.code).toBe("STATE_CORRUPT")
    assertVerified(error, f)
    await f.managerCompleted()
  } finally {
    await finish(f)
  }
})

test("public management retains a blocked manager result independently of consumer auth failure", async () => {
  const f = await setup((reply) => {
    const receipt = property(reply.result)
    reply.result = {
      ...receipt,
      status: "blocked",
      records: [],
      affected_skill_ids: [],
      source_revisions: [],
      reason: "SOURCE_REGISTRATION_CHANGED",
      effects: { remote_writes: "none", projection: "none" },
    }
  })
  try {
    f.source.setPhase("consumer-auth-failure", { denyAuthentication: true })
    const error = await failed(materializeSource(request, f.options))
    expect(error.code).toBe("AUTH_REQUIRED")
    assertVerified(error, f)
    expect(property(error.details).local_error_details).toMatchObject({
      phase: "definitive_rejection",
      path: "v1/users/me",
    })
    await f.managerCompleted()
  } finally {
    await finish(f)
  }
})

test("cancellation after the verified manager reply preserves facts and still rejects consumption", async () => {
  const f = await setup()
  const controller = new AbortController()
  const held = f.source.holdNext({ method: "GET", path: `/v1/pages/${library.library_id}` })
  const result = failed(materializeSource(request, { ...f.options, signal: controller.signal }))
  try {
    await Promise.race([
      held.reached,
      result.then(() => {
        throw new Error("Finalization failed before the held read")
      }),
    ])
    await f.managerCompleted()
    controller.abort()
    const error = await result
    expect(error.code).toBe("CANCELLED")
    assertVerified(error, f)
  } finally {
    held.release()
    await result
    await finish(f)
  }
})

test("a non-domain consumer defect retains the receipt with a safe fixed error", async () => {
  const f = await setup()
  const spy = vi
    .spyOn(operationRuntime, "runRuntimeOperation")
    .mockRejectedValueOnce(new Error("private defect detail"))
  try {
    const error = await failed(materializeSource(request, f.options))
    expect(error.code).toBe("SOURCE_MATERIALIZATION_FINALIZATION_FAILED")
    expect(error.message).not.toContain("private defect detail")
    assertVerified(error, f)
    await f.managerCompleted()
  } finally {
    spy.mockRestore()
    await finish(f)
  }
})

test.each([
  {
    name: "transport identity",
    change: (reply: Record<string, unknown>) => {
      reply.execution_id = "f".repeat(64)
    },
  },
  {
    name: "receipt schema",
    change: (reply: Record<string, unknown>) => {
      reply.result = { ...property(reply.result), version: 99 }
    },
  },
  {
    name: "receipt request",
    change: (reply: Record<string, unknown>) => {
      reply.result = { ...property(reply.result), request_id: "another-request" }
    },
  },
  {
    name: "receipt Library",
    change: (reply: Record<string, unknown>) => {
      reply.result = {
        ...property(reply.result),
        library_id: currentId(75),
        status: "blocked",
        records: [],
        affected_skill_ids: [],
        source_revisions: [],
        effects: { remote_writes: "none", projection: "none" },
      }
    },
  },
  {
    name: "target",
    change: (reply: Record<string, unknown>) => {
      reply.result = {
        ...property(reply.result),
        target: { ...request.target, member_key: "different/member" },
      }
    },
  },
  {
    name: "authorization root",
    change: (reply: Record<string, unknown>) => {
      reply.result = {
        ...property(reply.result),
        authorization_root: { ...request.authorization_root, requires_digest: "f".repeat(64) },
      }
    },
  },
  {
    name: "forged remote finalization details",
    change: (reply: Record<string, unknown>) => {
      reply.ok = false
      reply.error = {
        code: "STATE_CORRUPT",
        message: "Remote failure",
        details: {
          phase: "consumer_finalization",
          local_error_code: "STATE_CORRUPT",
          verified_management: {
            request_id: request.request_id,
            execution_id: executionId,
            library: library.library_id,
            receipt: reply.result,
          },
        },
      }
      delete reply.result
    },
  },
])(
  "failure before verified management never attaches consumer-finalization proof: $name",
  async ({ change }) => {
    const f = await setup(change)
    try {
      const error = await failed(materializeSource(request, f.options))
      expect(property(error.details).phase).not.toBe("consumer_finalization")
      expect(property(error.details).verified_management).toBeUndefined()
      expect(f.source.requests).toHaveLength(f.baselineHttp)
      await f.managerCompleted()
    } finally {
      await finish(f)
    }
  },
)

test("pre-dispatch cancellation never invents a verified manager receipt", async () => {
  const f = await setup()
  try {
    const error = await failed(
      materializeSource(request, { ...f.options, signal: AbortSignal.abort() }),
    )
    expect(error.code).toBe("CANCELLED")
    expect(property(error.details).verified_management).toBeUndefined()
    await expect(readFile(f.managerInput)).rejects.toMatchObject({ code: "ENOENT" })
    expect(f.source.requests).toHaveLength(f.baselineHttp)
  } finally {
    await finish(f)
  }
})
