import { beforeAll, expect, test } from "bun:test"
import { Effect } from "effect"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, writeFile, chmod, realpath, stat } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Notion } from "../../core/src/notion.ts"
import { property, text } from "../../core/src/model.ts"
import { parseYaml } from "../../core/src/yaml.ts"
import { writeSharedSkillFile } from "../../core/src/shared-authoring.ts"
import { withSharedAuthoringTarget } from "../../core/src/shared-authoring-context.ts"
import { reviewSharedBodyWrite } from "../../core/src/shared-body-write-review.ts"
import { updateSkill } from "../../core/src/command-operations.ts"
import {
  authoringRead,
  pendingSingleBody,
  payloads,
  withNativeWrites,
  skillPage,
  library as reviewLibrary,
} from "../../core/test/shared-single-body-apply-acceptance-fixture.ts"
import { gitMainFixture, library, sha } from "../../core/test/shared-git-main-takeover-fixture.ts"
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
  const [out, err, code] = await Promise.all([
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
    build.exited,
  ])
  if (code) throw new Error(`Build failed: ${out}\n${err}`)
}, 120_000)

for (const readback of ["exact", "reviewed", "review-completed"] as const)
  test("real Node ctl and bundled SDK consume the same Git main and explicit header through SQLite (" +
    readback +
    ")", async () => {
    const reviewed = readback !== "exact"
    const f = await gitMainFixture()
    const root = await realpath(
      await mkdtemp(
        join(process.env.NTN_SKILLS_TEST_EVIDENCE_ROOT ?? tmpdir(), "ntn-git-main-cli-"),
      ),
    )
    const errors: string[] = [],
      calls: { phase: string; path: string; method: string; body: unknown; status: number }[] = []
    let gitRequests = 0,
      phase = "setup",
      hiddenReviewEvent = "",
      hideReviewEvent = false,
      hiddenReviewQueries = 0
    const recordFields: Readonly<Record<string, string>> = library.records.property_ids
    const recordText = (row: unknown, key: string) =>
      text(property(property(property(row).properties)[key]).rich_text)
    const recordId = (row: unknown) => recordText(row, recordFields["Record ID"]!)
    const recordPayload = (row: unknown) =>
      property(JSON.parse(recordText(row, recordFields.Payload!))).payload
    const recordRows = () => [...f.f.base.records.values()]
    const server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? "/", "http://127.0.0.1")
        if (url.pathname === "/fixed-git") {
          gitRequests++
          const original = new URL(url.searchParams.get("url")!)
          const entry = f.source.files.find(
            (file) =>
              original.pathname.endsWith(`/${file.source_path}`) ||
              original.pathname.endsWith(`/${file.git_oid}`),
          )
          if (!entry) throw new Error(`Unexpected fixed source path: ${original.pathname}`)
          const content = f.member.portable.files.find((file) => file.path === entry.path)!.bytes
          response.writeHead(200, { "content-length": String(content.length) })
          response.end(content)
          return
        }
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const bytes = Buffer.concat(chunks)
        const body: unknown = bytes.length ? JSON.parse(bytes.toString()) : undefined
        const method = request.method
        if (method !== "GET" && method !== "POST" && method !== "PATCH")
          throw new Error("Unexpected method")
        const call = { phase, path: url.pathname, method, body, status: 0 }
        calls.push(call)
        if (url.pathname === "/v1/users/me") {
          call.status = 200
          return json(response, 200, {
            object: "user",
            id: id(99),
            type: "bot",
            bot: { workspace_id: id(100) },
          })
        }
        let result = await f.run(
          Effect.flatMap(Notion, (api) =>
            api.request(url.pathname.slice(1) + url.search, body, { method }),
          ),
        )
        call.status = 200
        // The POST remains acknowledged and retained; only the immediate complete
        // file-event query lags, so the original review never sends its receipt.
        if (
          hideReviewEvent &&
          url.pathname === `/v1/data_sources/${library.records.data_source_id}/query` &&
          JSON.stringify(property(body).filter).includes('"file_event"')
        ) {
          const raw = property(result)
          if (Array.isArray(raw.results)) {
            const visible = raw.results.filter((row) => recordId(row) !== hiddenReviewEvent)
            if (visible.length !== raw.results.length) hiddenReviewQueries++
            result = { ...raw, results: visible }
          }
        }
        return json(response, 200, result)
      } catch (error) {
        errors.push(String(error))
        json(response, 400, { object: "error", code: "validation_error", message: String(error) })
      }
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (address === null || typeof address === "string")
      throw new Error("No controlled HTTP address")
    const origin = `http://127.0.0.1:${address.port}`
    const preload = join(root, "controlled-git-fetch.mjs")
    await writeFile(
      preload,
      `const fetchOriginal = globalThis.fetch;
globalThis.fetch = (request, options) => {
  const url = new URL(typeof request === "string" || request instanceof URL ? request : request.url);
  if (["raw.githubusercontent.com", "api.github.com"].includes(url.hostname))
    return fetchOriginal(${JSON.stringify(origin)} + "/fixed-git?url=" + encodeURIComponent(url.href), options);
  if (url.origin !== ${JSON.stringify(origin)}) throw new Error("Uncontrolled network request");
  return fetchOriginal(request, options);
};\n`,
    )
    const nodeShim = Bun.which("node")
    if (!nodeShim) throw new Error("Node is required")
    const node = execFileSync(nodeShim, ["--print", "process.execPath"], {
      encoding: "utf8",
    }).trim()
    const envFor = (client: string) => ({
      ...process.env,
      NOTION_API_TOKEN: "controlled-git-main-token",
      NOTION_API_BASE_URL: origin,
      NOTION_WORKSPACE_ID: "",
      NTN_SKILLS_DEV_ROOT: undefined,
      GH_TOKEN: "controlled-git-main-github-token",
      GITHUB_TOKEN: undefined,
      NTN_SKILLS_HOME: join(root, client, "state"),
      NTN_SKILLS_CONFIG_HOME: join(root, client, "config"),
      NTN_SKILLS_CACHE_HOME: join(root, client, "cache"),
      NTN_SKILLS_DATA_HOME: join(root, client, "data"),
      NTN_SKILLS_SCHEDULER_ROOT: join(root, client, "scheduler"),
      NTN_SKILLS_NOTION_INTERVAL_MS: "100",
    })
    const cli = async (label: string, argv: string[], client = "writer", expectedExit = 0) => {
      phase = label
      const child = Bun.spawn([node, "--import", preload, executable, ...argv], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: envFor(client),
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      await writeFile(join(root, `${label}.stdout.json`), stdout)
      await writeFile(join(root, `${label}.stderr.log`), stderr)
      await writeFile(join(root, `${label}.command.json`), JSON.stringify({ argv, client, code }))
      expect(errors, label).toEqual([])
      expect(code, `${label}: ${stdout} ${stderr}`).toBe(expectedExit)
      return property(JSON.parse(stdout))
    }
    const pendingJournal = () => {
      const rows: unknown[] = JSON.parse(
        execFileSync(
          node,
          [
            "--input-type=module",
            "--eval",
            `import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(${JSON.stringify(join(root, "writer", "state", "state.sqlite"))}, {readOnly:true});
try { console.log(JSON.stringify(db.prepare("SELECT key,payload FROM shared_local_records WHERE category='dispatch' AND retired=0 AND key LIKE 'operations/shared-observation-pending/%' ORDER BY key").all())); } finally { db.close(); }`,
          ],
          { encoding: "utf8" },
        ),
      )
      return rows.map((row) => {
        const value = property(row)
        return { key: value.key, value: JSON.parse(String(value.payload)) }
      })
    }
    const input = join(root, "SKILL.md")
    const original = new TextDecoder().decode(f.original.bytes)
    let local = original
      .replace("user-invokable: true", "user-invokable: false\ncustom: [one, two]")
      .replace("Keep all source documents.", "Keep the complete edited local main.")
    if (reviewed) {
      local = local.replace(
        "Keep the complete edited local main.",
        "1. **First step**:\n   - Keep every local instruction.\n\n2. **Second step**:\n   - Keep all source documents.",
      )
      f.renderNative(
        () =>
          "# Initial\n\n1. <b>First step</b>:\n\t- Keep every local instruction.\n2. <b>Second step</b>:\n\t- Keep all source documents.",
      )
    }
    await writeFile(input, local)
    await chmod(input, 0o755)
    const args = [
      "ctl",
      "library",
      "file",
      "takeover",
      f.target,
      "SKILL.md",
      "--entry",
      library.skills.database_id,
    ]
    const writes = () =>
      calls.filter(
        (call) => call.method === "PATCH" || (call.method === "POST" && call.path === "/v1/pages"),
      )
    try {
      const preview = await cli("prepare", [...args, "--input", input, "--dry-run"])
      expect(writes()).toHaveLength(0)
      const plan = property(preview.plan)
      expect(property(plan.git_main_initialization).source_input).toBe(original)
      const planFile = join(root, "original-plan.json")
      await writeFile(planFile, JSON.stringify(plan))
      const applied = await cli("apply", [...args, "--plan", planFile], "writer", reviewed ? 1 : 0)
      if (reviewed) {
        expect(property(applied.error).code).toBe("SHARED_BODY_WRITE_REVIEW_REQUIRED")
        const beforeReview = writes().length
        const reviewArgs = [
          "ctl",
          "library",
          "file",
          "review",
          f.target,
          String(plan.operation_id),
          "--entry",
          library.skills.database_id,
          "--accept-observed-sha256",
          sha(f.markdown()),
        ]
        const reviewPreview = await cli("review-dry-run", [...reviewArgs, "--dry-run"])
        expect(reviewPreview.status).toBe("planned")
        expect(writes()).toHaveLength(beforeReview)
        if (readback === "review-completed") {
          const reviewPlan = property(reviewPreview.plan),
            reviewId = String(reviewPlan.operation_id),
            receiptId = `reviewed-${reviewId}`,
            completionId = `completed-v1-${reviewId}`
          expect(reviewPlan.version).toBe(2)
          hiddenReviewEvent = String(property(reviewPlan.event).event_id)
          hideReviewEvent = true
          const failedReview = await cli("review-apply-missing-receipt", reviewArgs, "writer", 1)
          hideReviewEvent = false
          expect(property(failedReview.error).code).toBe("BASELINE_MISSING")
          expect(hiddenReviewQueries).toBeGreaterThan(0)
          const reviewWrites = writes().slice(beforeReview)
          expect(reviewWrites.map((call) => recordId(call.body))).toEqual([
            reviewId,
            String(property(reviewPlan.content).object_id),
            hiddenReviewEvent,
          ])
          expect(reviewWrites.every((call) => call.status === 200)).toBe(true)
          expect(recordRows().some((row) => recordId(row) === receiptId)).toBe(false)
          const journal = pendingJournal()
          expect(
            journal.find((entry) => property(property(entry.value).plan).operation_id === reviewId),
          ).toMatchObject({ value: { plan: reviewPlan } })
          await writeFile(join(root, "original-review-journal.json"), JSON.stringify(journal))
          const recordsBefore = structuredClone(recordRows()),
            ownerBefore = structuredClone(f.row),
            bodyBefore = f.markdown(),
            beforeCompletion = writes().length
          const originalOutcome = recordsBefore.find(
            (row) =>
              property(recordPayload(row)).kind === "body_write_outcome" &&
              property(recordPayload(row)).operation_id === plan.operation_id,
          )
          expect(property(recordPayload(originalOutcome)).status).toBe("needs_review")
          const unresolved = await cli(
            "original-review-reconcile",
            [...reviewArgs, "--reconcile"],
            "writer",
            1,
          )
          expect(property(unresolved.error).code).toBe("SHARED_RECORD_UNRESOLVED")
          expect(property(property(unresolved.error).details).record_id).toBe(receiptId)
          expect(writes()).toHaveLength(beforeCompletion)
          const completionPreview = await cli("review-complete-dry-run", [
            ...reviewArgs,
            "--complete",
            "--dry-run",
          ])
          expect(completionPreview).toMatchObject({
            status: "planned",
            operation_id: reviewId,
            completion_operation_id: completionId,
            original_status: "needs_review",
            write_plan: {
              immutable_records: 1,
              native_body_patches: 0,
              original_review_receipt: "unproven",
            },
          })
          expect(writes()).toHaveLength(beforeCompletion)
          expect(pendingJournal()).toEqual(journal)
          const completed = await cli("review-complete-apply", [...reviewArgs, "--complete"])
          expect(completed).toMatchObject({
            status: "reviewed",
            decision: "accepted_observed",
            original_status: "needs_review",
            operation_id: reviewId,
            completion_operation_id: completionId,
            original_operation_id: plan.operation_id,
            verified: true,
          })
          const completionWrites = writes().slice(beforeCompletion)
          expect(completionWrites).toHaveLength(1)
          expect(completionWrites[0]).toMatchObject({
            method: "POST",
            path: "/v1/pages",
            status: 200,
          })
          expect(recordId(completionWrites[0]!.body)).toBe(completionId)
          expect(recordRows()).toHaveLength(recordsBefore.length + 1)
          for (const row of recordsBefore)
            expect(recordRows().find((current) => recordId(current) === recordId(row))).toEqual(row)
          expect(
            recordPayload(recordRows().find((row) => recordId(row) === completionId)),
          ).toMatchObject({
            kind: "body_write_review_completion",
            operation_id: completionId,
            review_operation_id: reviewId,
            original_operation_id: plan.operation_id,
            original_status: "needs_review",
            status: "reviewed",
            original_review_receipt: "unproven",
          })
          expect(recordRows().some((row) => recordId(row) === receiptId)).toBe(false)
          expect(f.row).toEqual(ownerBefore)
          expect(f.markdown()).toBe(bodyBefore)
          await writeFile(
            join(root, "completion-proof.json"),
            JSON.stringify({
              review_id: reviewId,
              completion_id: completionId,
              hidden_review_queries: hiddenReviewQueries,
              original_records: recordsBefore,
              completed_records: recordRows(),
              original_outcome: recordPayload(originalOutcome),
              original_receipt_present: false,
              original_review_writes: reviewWrites,
              completion_writes: completionWrites,
              body_sha256: sha(bodyBefore),
            }),
          )
        } else expect((await cli("review-apply", reviewArgs)).decision).toBe("accepted_observed")
      } else expect(applied.status).toBe("applied")
      expect(f.bodyWrites).toHaveLength(1)
      const after = writes().length
      const repeated = await cli("reconcile", [...args, "--plan", planFile, "--reconcile"])
      expect(repeated.status).toBe(reviewed ? "reviewed" : "applied")
      expect(writes()).toHaveLength(after)
      const beforeMain = gitRequests
      if (readback === "review-completed")
        await expect(stat(join(root, "cold"))).rejects.toMatchObject({ code: "ENOENT" })
      const read = await cli(
        "cold-read",
        ["read", f.target, "--database", library.skills.database_id, "--read-only"],
        "cold",
      )
      expect(read.ok).toBe(true)
      expect(gitRequests).toBe(beforeMain)
      const beforeOffline = calls.length
      const offline = await cli(
        "offline-missing",
        [
          "export",
          f.target,
          "--database",
          library.skills.database_id,
          "--projection",
          "snapshot",
          "--offline",
          "--output",
          join(root, "offline-export"),
        ],
        "cold",
        1,
      )
      expect(property(offline.error).code).toBe("SNAPSHOT_MISSING")
      expect(calls).toHaveLength(beforeOffline)
      expect(gitRequests).toBe(beforeMain)
      if (readback === "review-completed")
        await expect(stat(join(root, "exporter"))).rejects.toMatchObject({ code: "ENOENT" })
      const exported = await cli(
        "cold-export",
        [
          "export",
          f.target,
          "--database",
          library.skills.database_id,
          "--projection",
          "snapshot",
          "--output",
          join(root, "export"),
        ],
        "exporter",
      )
      expect(exported.ok).toBe(true)
      expect(writes()).toHaveLength(after)
      const rendered = await readFile(join(root, "export", "SKILL.md"), "utf8")
      const yaml = (value: string) => parseYaml(/^---\n([\s\S]*?)\n---/u.exec(value)![1]!)
      expect(yaml(rendered)).toEqual(yaml(local))
      expect(rendered).toContain(
        reviewed ? "Keep every local instruction." : "Keep the complete edited local main.",
      )
      if (readback === "review-completed") {
        expect(read.content).toBe(rendered)
        expect(rendered.replace(/^---\n[\s\S]*?\n---\n\n/u, "")).toBe(f.markdown() + "\n")
      }
      const exportedModes = []
      for (const file of f.member.portable.files) {
        if (file.path !== "SKILL.md")
          expect(sha(await readFile(join(root, "export", file.path)))).toBe(sha(file.bytes))
        const diskMode = (await stat(join(root, "export", file.path))).mode & 0o777,
          gitMode = diskMode & 0o111 ? "100755" : "100644",
          expectedMode = file.path === "SKILL.md" ? "100755" : file.mode
        if (expectedMode === undefined) throw new Error(`Missing fixed Git mode for ${file.path}`)
        expect(gitMode).toBe(expectedMode)
        exportedModes.push({
          path: file.path,
          expected_git_mode: expectedMode,
          actual_git_mode: gitMode,
          disk_mode: diskMode.toString(8),
        })
      }
      await writeFile(join(root, "export-modes.json"), JSON.stringify(exportedModes))
      expect(f.f.skills.has(f.target)).toBe(true)
      expect(f.f.nativeCreates()).toHaveLength(0)
      const headerInput = join(root, "header-input.md")
      await writeFile(headerInput, rendered.replace(/^---\n/u, "---\nheader-only-version: 2\n"))
      const beforeHeader = writes().length
      const headerPreview = await cli("header-prepare", [
        ...args,
        "--header-input",
        headerInput,
        "--dry-run",
      ])
      expect(writes()).toHaveLength(beforeHeader)
      expect(property(headerPreview.header_change).before).toHaveProperty("frontmatter")
      const headerPlan = join(root, "header-plan.json")
      await writeFile(headerPlan, JSON.stringify(headerPreview.plan))
      const nativeBefore = f.markdown()
      expect((await cli("header-apply", [...args, "--plan", headerPlan])).status).toBe(
        "verified_applied",
      )
      expect(f.markdown()).toBe(nativeBefore)
      expect(f.bodyWrites).toHaveLength(1)
      expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(1)
      const afterHeader = writes().length
      const sdkEntry = new URL("./sdk.js", pathToFileURL(executable)).href
      const sdkProcess = Bun.spawn(
        [
          node,
          "--import",
          preload,
          "--input-type=module",
          "--eval",
          "const sdk=await import(" +
            JSON.stringify(sdkEntry) +
            ");let metrics;" +
            "const result=await sdk.readSkill(" +
            JSON.stringify(f.target) +
            ",{database:" +
            JSON.stringify(library.skills.database_id) +
            ",readOnly:true,metrics:true,onRequestMetrics:v=>metrics=v});" +
            "console.log(JSON.stringify({result,metrics}));",
        ],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: envFor("sdk-cold") },
      )
      const [sdkOut, sdkErr, sdkCode] = await Promise.all([
        new Response(sdkProcess.stdout).text(),
        new Response(sdkProcess.stderr).text(),
        sdkProcess.exited,
      ])
      await writeFile(join(root, "cold-sdk-read.json"), sdkOut)
      expect(sdkCode, sdkErr).toBe(0)
      const sdk = property(JSON.parse(sdkOut)),
        sdkRead = property(sdk.result)
      expect(sdkRead.snapshot_id).not.toBe(read.snapshot_id)
      expect(String(sdkRead.content)).toContain('"header-only-version": 2')
      expect(String(sdkRead.content)).toContain(
        reviewed ? "Keep every local instruction." : "Keep the complete edited local main.",
      )
      expect(property(property(sdk.metrics).requests).notion_write).toBe(0)
      expect(writes()).toHaveLength(afterHeader)
      expect(errors).toEqual([])
      console.log(
        JSON.stringify({ journey: readback, evidence_root: root, executable, sdk_entry: sdkEntry }),
      )
    } finally {
      await writeFile(join(root, "http-calls.json"), JSON.stringify(calls))
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  }, 180_000)

test("a fresh Node SDK consumes a separately corrected known-review parent without changing its original history", async () => {
  const original = await pendingSingleBody("known-mismatch")
  const { f, child } = original
  await f.run(
    reviewSharedBodyWrite({
      library: reviewLibrary,
      skillPageId: skillPage,
      originalOperationId: child.operation_id,
      acceptedObservedSha256: sha(f.bodies.get(skillPage)!),
      scope: original.plan.snapshot_scope,
      mode: "create",
      dryRun: false,
    }),
  )
  const snapshot = await authoringRead(f)
  const body =
    "# Milestone\n\nRead [Skeleton](https://www.notion.so/4135636c236e81918226d828c7b44b39) (`skill://4135636c-236e-8191-8226-d828c7b44b39/SKILL.md`) before implementation.\n"
  const native =
    "# Milestone\n\nRead [Skeleton](https://app.notion.com/p/4135636c236e81918226d828c7b44b39) (<code>skill://4135636c-236e-8191-8226-d828c7b44b39/SKILL.md</code>) before implementation."
  await f.run(
    withNativeWrites(
      f,
      withSharedAuthoringTarget(
        skillPage,
        writeSharedSkillFile({
          snapshot,
          path: "SKILL.md",
          bytes: new TextEncoder().encode(
            "---\nname: Managed Name\ndescription: Managed description\n---\n\n" + body,
          ),
        }),
      ),
      native,
    ),
  )
  await f.run(
    withNativeWrites(
      f,
      updateSkill(skillPage, { database: reviewLibrary.skills.database_id, enabled: true }),
    ),
  )
  const originalOutcome = payloads(f).find(
    (value) =>
      property(value).kind === "body_write_outcome" &&
      property(value).operation_id === child.operation_id,
  )
  expect(originalOutcome).toMatchObject({ status: "needs_review" })
  expect(payloads(f).some((value) => property(value).kind === "skill_apply_outcome")).toBe(false)
  f.clearCalls()
  const root = await realpath(
    await mkdtemp(
      join(process.env.NTN_SKILLS_TEST_EVIDENCE_ROOT ?? tmpdir(), "ntn-known-review-sdk-"),
    ),
  )
  const errors: string[] = []
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      if (url.pathname === "/v1/users/me")
        return json(response, 200, {
          object: "user",
          id: id(99),
          type: "bot",
          bot: { workspace_id: id(100) },
        })
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const bytes = Buffer.concat(chunks),
        body: unknown = bytes.length ? JSON.parse(bytes.toString()) : undefined
      const method = request.method
      if (method !== "GET" && method !== "POST") throw new Error("Unexpected SDK mutation")
      if (method === "POST" && url.pathname === "/v1/pages")
        throw new Error("Unexpected SDK Record mutation")
      return json(
        response,
        200,
        await f.run(
          Effect.flatMap(Notion, (api) =>
            api.request(url.pathname.slice(1) + url.search, body, { method }),
          ),
        ),
      )
    } catch (error) {
      errors.push(String(error))
      json(response, 400, { object: "error", code: "validation_error", message: String(error) })
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("Missing local address")
  const origin = `http://127.0.0.1:${address.port}`
  const preload = join(root, "only-controlled-http.mjs")
  await writeFile(
    preload,
    `const original=globalThis.fetch;globalThis.fetch=(input,options)=>{const url=new URL(typeof input==="string"||input instanceof URL?input:input.url);if(url.origin!==${JSON.stringify(origin)})throw new Error("Uncontrolled network request");return original(input,options)};\n`,
  )
  const nodeShim = Bun.which("node")
  if (!nodeShim) throw new Error("Node is required")
  const node = execFileSync(nodeShim, ["--print", "process.execPath"], { encoding: "utf8" }).trim()
  const sdkEntry = new URL("./sdk.js", pathToFileURL(executable)).href
  try {
    const process = Bun.spawn(
      [
        node,
        "--import",
        preload,
        "--input-type=module",
        "--eval",
        "const sdk=await import(" +
          JSON.stringify(sdkEntry) +
          ");let metrics;const result=await sdk.readSkill(" +
          JSON.stringify(skillPage) +
          ",{database:" +
          JSON.stringify(reviewLibrary.skills.database_id) +
          ",readOnly:true,metrics:true,onRequestMetrics:v=>metrics=v});console.log(JSON.stringify({result,metrics}));",
      ],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...globalThis.process.env,
          NOTION_API_TOKEN: "controlled-known-review-token",
          NOTION_API_BASE_URL: origin,
          NOTION_WORKSPACE_ID: "",
          NTN_SKILLS_DEV_ROOT: undefined,
          NTN_SKILLS_HOME: join(root, "state"),
          NTN_SKILLS_CONFIG_HOME: join(root, "config"),
          NTN_SKILLS_CACHE_HOME: join(root, "cache"),
          NTN_SKILLS_DATA_HOME: join(root, "data"),
          NTN_SKILLS_SCHEDULER_ROOT: join(root, "scheduler"),
          NTN_SKILLS_NOTION_INTERVAL_MS: "100",
        },
      },
    )
    const [out, err, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ])
    await writeFile(join(root, "cold-sdk-read.json"), out)
    await writeFile(join(root, "http-calls.json"), JSON.stringify(f.calls))
    expect(code, err + out).toBe(0)
    expect(errors).toEqual([])
    const result = property(JSON.parse(out))
    expect(String(property(result.result).content)).toContain(native)
    expect(property(property(result.metrics).requests).notion_write).toBe(0)
    expect(f.writeCount()).toBe(0)
    expect(
      payloads(f).find(
        (value) =>
          property(value).kind === "body_write_outcome" &&
          property(value).operation_id === child.operation_id,
      ),
    ).toEqual(originalOutcome)
    expect(payloads(f).some((value) => property(value).kind === "skill_apply_outcome")).toBe(false)
    console.log(
      JSON.stringify({
        journey: "known-review-correction",
        evidence_root: root,
        executable,
        sdk_entry: sdkEntry,
      }),
    )
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
}, 90000)
