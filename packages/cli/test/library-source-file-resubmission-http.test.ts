import { beforeAll, expect, test } from "bun:test"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { property, text } from "../../core/src/model.ts"
import { Notion } from "../../core/src/notion.ts"
import { prepareSharedSourceProjection } from "../../core/src/shared-source-projection.ts"
import { readSourceDefinition } from "../../core/src/shared-source-definitions.ts"
import { canonicalSharedJson } from "../../core/src/shared-records.ts"
import { sharedCreateOutcomeId } from "../../core/src/shared-create-outcome.ts"
import { fixture, library } from "../../core/test/shared-source-projection-fixture.ts"
import { id } from "../../core/test/shared-snapshot-fixture.ts"
import { json } from "../../core/test/notion-http-fixture.ts"

const executable =
  process.env.NTN_SKILLS_TEST_EXECUTABLE ??
  new URL("../dist/ntn-skills.js", import.meta.url).pathname
beforeAll(async () => {
  if (process.env.NTN_SKILLS_TEST_EXECUTABLE !== undefined) return
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
  if (exit !== 0) throw new Error(`Production CLI build failed: ${stdout}\n${stderr}`)
}, 120_000)

const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const field = (value: unknown, key: string) => {
  const result = property(value)[key]
  if (typeof result !== "string") throw new Error(`Expected ${key}`)
  return result
}

test("public Node CLI and SDK independently resubmit one rejected file and cold-verify its original recovery", async () => {
  const evidence = process.env.NTN_SOURCE_FILE_RESUBMISSION_EVIDENCE_DIR
  if (evidence) await mkdir(evidence, { recursive: true })
  const directory = await realpath(
    await mkdtemp(join(evidence ?? tmpdir(), "ntn-file-resubmission-http-")),
  )
  const state = join(directory, "state")
  const nodeShim = Bun.which("node")
  if (nodeShim === null) throw new Error("Node is required")
  const node = execFileSync(nodeShim, ["--print", "process.execPath"], { encoding: "utf8" }).trim()
  const target = "references/rejected.md"
  const original =
    "# Rejected\n\n" +
    Array.from(
      { length: 10 },
      (_, index) =>
        `[![Badge ${index}](https://img.example/${index}.svg)](https://example.org/${index})`,
    ).join("\n") +
    "\n\nPreserve all links, 中文 and the original suffix.\n"
  // Keep this fixture's main in the existing canonical consumer format so every
  // cold file has an independent exact-byte oracle, including the main entry.
  const main =
    '---\n"description": "Initial complete member"\n"license": "MIT"\n"name": "initial-source"\n---\n\n# Initial\n\n[Guide](references/a.md) [Script](scripts/run.js) ![Icon](assets/icon.png)\n'
  const f = fixture(
    [
      {
        path: "references/b-before.md",
        bytes: new TextEncoder().encode("# Before\n\nConfirmed prefix.\n"),
        mode: "100644",
      },
      { path: target, bytes: new TextEncoder().encode(original), mode: "100644" },
      {
        path: "references/z-tail.md",
        bytes: new TextEncoder().encode("# Tail\n\nUnissued original suffix.\n"),
        mode: "100644",
      },
    ],
    { main, markdownImport: true, recovery: true },
  )
  f.skills.clear()
  f.files.clear()
  f.base.records.clear()
  const plan = await f.run(
    Effect.gen(function* () {
      return yield* prepareSharedSourceProjection({
        library,
        definition: yield* readSourceDefinition(library, f.source.id),
        acquired: f.snapshot,
        member: "skills/demo",
        skillId: "http-file-resubmission",
        enabled: false,
        markdownImport: true,
        storage: "retained",
      })
    }),
  )
  const planFile = join(directory, "original-plan.json")
  const originalPlanBytes = JSON.stringify(plan, null, 2) + "\n"
  await writeFile(planFile, originalPlanBytes)
  const commands: unknown[] = [],
    errors: string[] = []
  const calls: Array<{
    phase: string
    path: string
    method: string
    body: unknown
    status?: number
    response_bytes?: number
  }> = []
  let phase = "setup",
    rejectPrefix = true,
    rejectOriginal = true
  const journal = () => {
    const raw = execFileSync(
      node,
      [
        "--input-type=module",
        "--eval",
        `
import {DatabaseSync} from "node:sqlite";
const db=new DatabaseSync(${JSON.stringify(join(state, "state.sqlite"))},{readOnly:true});
try{console.log(JSON.stringify(db.prepare("SELECT key,payload FROM shared_local_records WHERE category='dispatch' AND retired=0").all()));}finally{db.close();}
`,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    )
    const rows: unknown = JSON.parse(raw)
    if (!Array.isArray(rows)) throw new Error("Expected complete author journal rows")
    return rows.map((row) => ({ key: field(row, "key"), value: JSON.parse(field(row, "payload")) }))
  }
  const nativePath = (body: unknown) =>
    text(property(property(property(body).properties)[library.files.property_ids.Path!]).rich_text)
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const bytes = Buffer.concat(chunks)
      const method = request.method
      if (method !== "GET" && method !== "POST" && method !== "PATCH")
        throw new Error(`Unexpected method ${method}`)
      const body: unknown = bytes.length === 0 ? undefined : JSON.parse(bytes.toString())
      const call = { phase, path: url.pathname, method, body, status: 0, response_bytes: 0 }
      calls.push(call)
      const reply = (status: number, result: unknown) => {
        call.status = status
        call.response_bytes = Buffer.byteLength(JSON.stringify(result))
        return json(response, status, result, {
          "x-request-id": `resubmission-http-${calls.length}`,
        })
      }
      if (url.pathname === "/v1/users/me")
        return reply(200, {
          object: "user",
          id: id(99),
          type: "bot",
          bot: { workspace_id: id(100) },
        })
      const parent = property(property(body).parent).data_source_id
      if (
        method === "POST" &&
        url.pathname === "/v1/pages" &&
        (parent === library.skills.data_source_id || parent === library.files.data_source_id)
      ) {
        const rows = journal()
        if (!rows.some((row) => row.key.startsWith("operations/shared-native-create/")))
          throw new Error("Native creation preceded the durable original journal")
        for (const row of rows) f.base.json.set(row.key, row.value)
        if (
          rejectOriginal &&
          parent === library.files.data_source_id &&
          nativePath(body) === target
        ) {
          rejectOriginal = false
          return reply(400, {
            object: "error",
            status: 400,
            code: "validation_error",
            message: "Controlled definitive image paragraph rejection",
          })
        }
      }
      const result = await f.run(
        Effect.flatMap(Notion, (api) =>
          api.request(url.pathname.slice(1) + url.search, body, { method }),
        ),
      )
      const page = /^\/v1\/pages\/([^/]+)\/markdown$/u.exec(url.pathname)?.[1]
      if (rejectPrefix && method === "GET" && page !== undefined && f.files.has(page))
        return reply(200, { ...property(result), markdown: "# Controlled prior prefix mismatch\n" })
      return reply(200, result)
    } catch (error) {
      errors.push(String(error))
      json(response, 400, { object: "error", code: "validation_error", message: String(error) })
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("Expected loopback address")
  const env = {
    ...process.env,
    NOTION_API_TOKEN: "controlled-file-resubmission-token",
    NOTION_API_BASE_URL: `http://127.0.0.1:${address.port}`,
    NOTION_WORKSPACE_ID: "",
    NTN_SKILLS_HOME: state,
    NTN_SKILLS_CONFIG_HOME: join(directory, "config"),
    NTN_SKILLS_CACHE_HOME: join(directory, "cache"),
    NTN_SKILLS_DATA_HOME: join(directory, "data"),
    NTN_SKILLS_SCHEDULER_ROOT: join(directory, "scheduler"),
    NTN_SKILLS_NOTION_INTERVAL_MS: "100",
    NTN_SKILLS_REQUEST_TRACE_LIMIT: "10000",
    NTN_SKILLS_DEV_ROOT: undefined,
  }
  const coldEnv = {
    ...env,
    NTN_SKILLS_HOME: join(directory, "cold-state"),
    NTN_SKILLS_CONFIG_HOME: join(directory, "cold-config"),
    NTN_SKILLS_CACHE_HOME: join(directory, "cold-cache"),
    NTN_SKILLS_DATA_HOME: join(directory, "cold-data"),
  }
  const run = async (label: string, argv: string[], exitCode = 0, cold = false) => {
    phase = label
    const start = calls.length
    const child = Bun.spawn([node, ...argv], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: cold ? coldEnv : env,
    })
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    await writeFile(join(directory, `${label}.stdout.json`), stdout)
    commands.push({
      label,
      argv,
      exit,
      cold,
      stdout_sha256: hash(stdout),
      stderr_sha256: hash(stderr),
      stderr_bytes: Buffer.byteLength(stderr),
      requests: calls.length - start,
      response_bytes: calls.slice(start).reduce((sum, call) => sum + (call.response_bytes ?? 0), 0),
    })
    await writeFile(join(directory, "commands.json"), JSON.stringify(commands, null, 2) + "\n")
    const diagnosis = `${label}: ${stdout.slice(0, 1200)} ${stderr.slice(0, 1200)}`
    expect(errors, diagnosis).toEqual([])
    expect(exit, diagnosis).toBe(exitCode)
    expect(stdout.trim(), diagnosis).not.toBe("")
    return property(JSON.parse(stdout))
  }
  const cli = (label: string, argv: string[], exitCode = 0, cold = false) =>
    run(label, [executable, ...argv], exitCode, cold)
  const sources = ["ctl", "library", "sources"],
    recovery = [...sources, "recovery"],
    resubmit = [...recovery, "resubmit-file"]
  const entry = ["--entry", library.skills.database_id]
  const writes = () =>
    calls.filter(
      (call) => call.method === "PATCH" || (call.method === "POST" && call.path === "/v1/pages"),
    )
  const targetPosts = () =>
    calls.filter(
      (call) =>
        call.method === "POST" && call.path === "/v1/pages" && nativePath(call.body) === target,
    )
  try {
    const refused = await cli(
      "original-prefix-failure",
      [...sources, "admit-apply", planFile, ...entry],
      1,
    )
    expect(property(refused.error).code).toBe("SHARED_CREATE_BODY_MISMATCH")
    expect(f.skills.size).toBe(1)
    expect(f.files.size).toBe(1)
    const page = [...f.skills.keys()][0]!
    const failure = [...f.base.records.values()].find(
      (row) =>
        text(property(property(row.properties).record).rich_text) ===
        sharedCreateOutcomeId(plan.operation_id),
    )
    expect(failure).toBeDefined()
    const originalFailure = canonicalSharedJson(failure)
    rejectPrefix = false
    const recoveryFile = join(directory, "original-recovery-review.json")
    const beforeReview = writes().length
    const reviewedParent = await cli("original-recovery-review", [
      ...recovery,
      "review",
      planFile,
      ...entry,
      "--target",
      page,
      "--output",
      recoveryFile,
    ])
    expect(writes()).toHaveLength(beforeReview)
    const parentArgs = [
      planFile,
      ...entry,
      "--review",
      recoveryFile,
      "--review-id",
      field(reviewedParent, "review_id"),
    ]
    const rejected = await cli(
      "original-native-rejection",
      [...recovery, "apply", ...parentArgs],
      1,
    )
    expect(property(rejected.error).code).toBe("SOURCE_WRITE_NOT_APPLIED")
    expect(targetPosts()).toHaveLength(1)
    expect(targetPosts()[0]!.status).toBe(400)
    const originalPost = canonicalSharedJson(targetPosts()[0]!.body)
    const beforeIndependent = writes().length
    const reviewFile = join(directory, "file-resubmission-review.json")
    const reviewed = await cli("file-review", [
      ...resubmit,
      "review",
      planFile,
      ...entry,
      "--target",
      page,
      "--path",
      target,
      "--output",
      reviewFile,
    ])
    expect(reviewed.remote_writes).toBe(0)
    expect(reviewed.changes).toEqual({
      paragraphs: 1,
      images: 10,
      linked_images: 10,
      inserted_line_feeds: 9,
    })
    const saved = property(JSON.parse(await readFile(reviewFile, "utf8")))
    const preservedJournal = journal().filter(
      (row) =>
        canonicalSharedJson(row.value) === canonicalSharedJson(saved.original_dispatch) ||
        canonicalSharedJson(row.value) === canonicalSharedJson(saved.original_rejection),
    )
    expect(preservedJournal).toHaveLength(2)
    const resubmitArgs = [
      planFile,
      ...entry,
      "--review",
      reviewFile,
      "--review-id",
      field(reviewed, "review_id"),
    ]
    const preview = await cli("file-preview", [...resubmit, "apply", ...resubmitArgs, "--dry-run"])
    expect(preview.remote_writes).toBe(0)
    expect(preview.native_pages_to_create).toBe(1)
    expect(writes()).toHaveLength(beforeIndependent)
    const sdkPath = pathToFileURL(join(dirname(executable), "sdk.js")).href
    const applyProbe = join(directory, "apply-file.mjs")
    await writeFile(
      applyProbe,
      `
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {applySourceFileResubmission} from ${JSON.stringify(sdkPath)};
assert.equal(process.env.NTN_SKILLS_DEV_ROOT,undefined);
const input={entry:${JSON.stringify(library.skills.database_id)},plan:JSON.parse(await readFile(${JSON.stringify(planFile)},"utf8")),review:JSON.parse(await readFile(${JSON.stringify(reviewFile)},"utf8")),reviewId:${JSON.stringify(field(reviewed, "review_id"))}};
const metrics=[];
const applied=await applySourceFileResubmission(input,{onRequestMetrics:m=>metrics.push(m)});
assert.equal(applied.result.verified,true);assert.equal(applied.result.original_creation_completed,false);
assert.deepEqual(applied.budget.limits,{requests:2000,bytes:134217728,duration_ms:300000});
const repeated=await applySourceFileResubmission(input,{onRequestMetrics:m=>metrics.push(m)});
assert.equal(repeated.result.remote_writes,0);
console.log(JSON.stringify({applied,repeated,metrics}));
`,
    )
    const independent = await run("sdk-file-apply", [applyProbe])
    expect(targetPosts()).toHaveLength(2)
    const newPost = targetPosts()[1]!
    expect(newPost.status).toBe(200)
    expect(canonicalSharedJson(newPost.body)).not.toBe(originalPost)
    const originalBody = property(targetPosts()[0]!.body)
    const originalShape = { ...originalBody, markdown: field(originalBody, "markdown") }
    expect({
      ...property(newPost.body),
      markdown: originalShape.markdown,
    }).toEqual(originalShape)
    expect(field(newPost.body, "markdown").length - originalShape.markdown.length).toBe(9)
    expect(
      (await cli("file-reconcile", [...resubmit, "reconcile", ...resubmitArgs])).verified,
    ).toBe(true)
    const parentPreviewWrites = writes().length
    const parentPreview = await cli("parent-preview", [
      ...recovery,
      "apply",
      ...parentArgs,
      "--dry-run",
    ])
    expect(parentPreview.remote_writes).toBe(0)
    expect(writes()).toHaveLength(parentPreviewWrites)
    const completed = await cli("parent-completion", [...recovery, "apply", ...parentArgs])
    expect(completed.verified).toBe(true)
    expect(await readFile(planFile, "utf8")).toBe(originalPlanBytes)
    expect(canonicalSharedJson(f.base.records.get(String(failure!.id)))).toBe(originalFailure)
    for (const preserved of preservedJournal)
      expect(journal().find((row) => row.key === preserved.key)).toEqual(preserved)
    expect(
      targetPosts().filter((call) => canonicalSharedJson(call.body) === originalPost),
    ).toHaveLength(1)
    expect(targetPosts()).toHaveLength(2)
    expect(f.skills.size).toBe(1)
    expect(f.files.size).toBe(plan.files.length - 1)
    const afterCompletion = writes().length
    f.base.json.clear()
    f.base.objects.clear()
    const cold = join(directory, "cold-verify.mjs")
    const expected = f.snapshot.members[0]!.portable.files.map((file) => ({
      path: file.path,
      sha256: hash(file.bytes),
    }))
    await writeFile(
      cold,
      `
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {reconcileSourceFileResubmission,reconcileSourceRecovery,readSkill,listSkill,readResources} from ${JSON.stringify(sdkPath)};
assert.equal(process.env.NTN_SKILLS_DEV_ROOT,undefined);
const entry=${JSON.stringify(library.skills.database_id)},target=${JSON.stringify(page)};
const plan=JSON.parse(await readFile(${JSON.stringify(planFile)},"utf8")),review=JSON.parse(await readFile(${JSON.stringify(reviewFile)},"utf8"));
const metrics=[],options={readOnly:true,onRequestMetrics:m=>metrics.push(m)};
const file=await reconcileSourceFileResubmission({entry,plan,review,reviewId:${JSON.stringify(field(reviewed, "review_id"))}},options);
assert.equal(file.result.verified,true);
const parent=await reconcileSourceRecovery({entry,plan,target},options);assert.equal(parent.result.verified,true);
const current=await readSkill(target,{...options,database:entry,authoring:true});assert.equal(current.record.enabled,false);
const listing=await listSkill(current.snapshot_id,{offline:true});
const expected=${JSON.stringify(expected)};assert.equal(listing.files.length,expected.length);
const mainHash=createHash("sha256").update(current.content).digest("hex");
assert.equal(mainHash,expected.find(e=>e.path===current.entrypoint)?.sha256);
const digests=[{path:current.entrypoint,sha256:mainHash}];
for(const item of listing.files.filter(item=>item.path!==current.entrypoint)){
 const received=await readResources({version:1,refs:[item.ref]},options);assert.equal(received.status,"ready");
 assert.equal(received.files.length,1);const raw=received.files[0];
 const bytes=raw.encoding==="base64"?Buffer.from(raw.content,"base64"):Buffer.from(raw.content);
 const sha256=createHash("sha256").update(bytes).digest("hex");
 assert.equal(sha256,expected.find(e=>e.path===item.path)?.sha256);digests.push({path:item.path,sha256});
}
assert.ok(metrics.every(m=>m.requests.notion_write===0));
console.log(JSON.stringify({file,parent,snapshot_id:current.snapshot_id,digests,metrics,authorStoreCopied:false}));
`,
    )
    const coldProof = await run("cold-proof-and-content", [cold], 0, true)
    expect(writes()).toHaveLength(afterCompletion)
    expect(
      (
        await cli(
          "cold-original-reconcile",
          [...recovery, "reconcile", planFile, ...entry, "--target", page],
          0,
          true,
        )
      ).verified,
    ).toBe(true)
    expect(writes()).toHaveLength(afterCompletion)
    expect(targetPosts()).toHaveLength(2)
    if (evidence) {
      await mkdir(evidence, { recursive: true })
      await writeFile(
        join(evidence, "receipt.json"),
        JSON.stringify(
          {
            kind: "public_node_cli_sdk_controlled_notion",
            actual_notion: false,
            cli: executable,
            cli_sha256: hash(await readFile(executable)),
            sdk_sha256: hash(await readFile(join(dirname(executable), "sdk.js"))),
            command_directory: directory,
            command_budget_limits: { requests: 2000, bytes: 134217728, duration_ms: 300000 },
            controlled_notion_interval_ms: 100,
            original_operation: plan.operation_id,
            target: page,
            original_post_attempts: 1,
            independent_post_attempts: 1,
            original_plan_and_failure_preserved: true,
            author_journal_copied_to_cold: false,
            completed,
            independent,
            coldProof,
            commands,
            trace: calls.map(({ body, ...call }) => ({
              ...call,
              request_sha256: body === undefined ? null : hash(canonicalSharedJson(body)),
            })),
          },
          null,
          2,
        ) + "\n",
      )
    }
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
}, 180_000)
