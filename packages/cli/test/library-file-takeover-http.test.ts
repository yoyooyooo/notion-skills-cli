import { beforeAll, expect, test } from "bun:test"
import { Effect } from "effect"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, writeFile, chmod, realpath, stat } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Notion } from "../../core/src/notion.ts"
import { property } from "../../core/src/model.ts"
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

for (const readback of ["exact", "reviewed"] as const)
  test("real Node ctl and bundled SDK consume the same Git main and explicit header through SQLite (" +
    readback +
    ")", async () => {
    const f = await gitMainFixture()
    const root = await realpath(
      await mkdtemp(
        join(process.env.NTN_SKILLS_TEST_EVIDENCE_ROOT ?? tmpdir(), "ntn-git-main-cli-"),
      ),
    )
    const errors: string[] = [],
      calls: { path: string; method: string }[] = []
    let gitRequests = 0
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
        calls.push({ path: url.pathname, method })
        if (url.pathname === "/v1/users/me")
          return json(response, 200, {
            object: "user",
            id: id(99),
            type: "bot",
            bot: { workspace_id: id(100) },
          })
        const result = await f.run(
          Effect.flatMap(Notion, (api) =>
            api.request(url.pathname.slice(1) + url.search, body, { method }),
          ),
        )
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
      expect(errors, label).toEqual([])
      expect(code, `${label}: ${stdout} ${stderr}`).toBe(expectedExit)
      return property(JSON.parse(stdout))
    }
    const input = join(root, "SKILL.md")
    const original = new TextDecoder().decode(f.original.bytes)
    let local = original
      .replace("user-invokable: true", "user-invokable: false\ncustom: [one, two]")
      .replace("Keep all source documents.", "Keep the complete edited local main.")
    if (readback === "reviewed") {
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
      const applied = await cli(
        "apply",
        [...args, "--plan", planFile],
        "writer",
        readback === "reviewed" ? 1 : 0,
      )
      if (readback === "reviewed") {
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
        expect((await cli("review-dry-run", [...reviewArgs, "--dry-run"])).status).toBe("planned")
        expect(writes()).toHaveLength(beforeReview)
        expect((await cli("review-apply", reviewArgs)).decision).toBe("accepted_observed")
      } else expect(applied.status).toBe("applied")
      expect(f.bodyWrites).toHaveLength(1)
      const after = writes().length
      const repeated = await cli("reconcile", [...args, "--plan", planFile, "--reconcile"])
      expect(repeated.status).toBe(readback === "reviewed" ? "reviewed" : "applied")
      expect(writes()).toHaveLength(after)
      const beforeMain = gitRequests
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
        readback === "reviewed"
          ? "Keep every local instruction."
          : "Keep the complete edited local main.",
      )
      expect((await stat(join(root, "export", "SKILL.md"))).mode & 0o111).not.toBe(0)
      for (const file of f.member.portable.files.filter((file) => file.path !== "SKILL.md"))
        expect(sha(await readFile(join(root, "export", file.path)))).toBe(sha(file.bytes))
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
        readback === "reviewed"
          ? "Keep every local instruction."
          : "Keep the complete edited local main.",
      )
      expect(property(property(sdk.metrics).requests).notion_write).toBe(0)
      expect(writes()).toHaveLength(afterHeader)
      expect(errors).toEqual([])
      console.log(
        JSON.stringify({ journey: readback, evidence_root: root, executable, sdk_entry: sdkEntry }),
      )
    } finally {
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
