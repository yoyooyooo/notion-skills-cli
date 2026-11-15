import { beforeAll, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { spawn, execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdtemp, mkdir, readFile, writeFile, rename, realpath } from "node:fs/promises"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { tmpdir } from "node:os"
import { Notion } from "../../core/src/notion.ts"
import { property, text } from "../../core/src/model.ts"
import { sourceDefinitionPropertiesFor } from "../../core/src/shared-source-definitions.ts"
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
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const skillPropertyIds: Readonly<Record<string, string>> = library.skills.property_ids
const field = (value: unknown, key: string) => {
  const result = property(value)[key]
  if (typeof result !== "string") throw new Error(`Expected ${key}`)
  return result
}

test("installed source member commands admit, explicitly remap and retain real Git changes without replacing selected content", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "ntn-source-members-")))
  const work = join(directory, "work"),
    repository = join(directory, "origin.git"),
    state = join(directory, "state")
  await mkdir(work)
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Source fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.test",
    GIT_COMMITTER_NAME: "Source fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.test",
  }
  const git = (root: string, ...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      env: gitEnv,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
  git(work, "init", "-b", "main")
  execFileSync("git", ["init", "--bare", "--initial-branch=main", repository], {
    env: gitEnv,
    stdio: "pipe",
  })
  git(work, "remote", "add", "origin", repository)
  const put = async (path: string, content: string | Uint8Array) => {
    await mkdir(join(work, path, ".."), { recursive: true })
    await writeFile(join(work, path), content)
  }
  const commit = () => {
    git(work, "add", "--all")
    git(work, "commit", "--no-gpg-sign", "-m", "Controlled source change")
    git(work, "push", "origin", "main")
    return git(work, "rev-parse", "HEAD")
  }
  await put(
    "skills/base/SKILL.md",
    "---\nname: existing-candidate\ndescription: Never implicitly admitted\n---\n\n# Base\n\n[Original](references/a-original.md) and [later](references/b-later.md).\n\n| Action | Input |\n| --- | --- |\n| New | `brief` + `content` |\n",
  )
  await put("skills/base/references/a-original.md", "## Original\n\n- \n")
  await put(
    "skills/base/references/b-later.md",
    "## Later\n\nRetain this complete original suffix.\n",
  )
  commit()
  const originalGuide =
    "# Original guide\n\nKeep the fixed source.\n\n" +
    Array.from(
      { length: 1400 },
      (_, index) =>
        `Instruction ${index}: preserve the complete source, quoted \"text\", 中文 and all reference content.\n\n`,
    ).join("")
  expect(Buffer.byteLength(originalGuide)).toBeGreaterThan(100 * 1024)
  const canonicalUrl = "https://example.test/source-fixture"
  const originalBinary = new Uint8Array([0, 255, 13, 10, 17])
  await put(
    "skills/fresh/SKILL.md",
    "---\nname: explicit-member\ndescription: Explicit source admission\nlicense: MIT\n---\n\n# New member\n\n##### Detailed instruction\n\nRead [guide](references/guide.md) and retain [bytes](assets/data.bin).\n" +
      `\nSource ${canonicalUrl}.\n\n<!-- canonical: ${canonicalUrl} -->\n\n## Empty summary\n\n- \n`,
  )
  await put("skills/fresh/references/guide.md", originalGuide)
  await put("skills/fresh/assets/data.bin", originalBinary)
  const firstRevision = commit()
  const f = fixture([], {
    recovery: true,
    readback: (wire) =>
      wire
        .replace(/<h1>(.*?)<\/h1>/u, "### $1")
        .replaceAll(canonicalUrl, `[${canonicalUrl}](${canonicalUrl})`)
        .replace("<!-- canonical:", "\\<!-- canonical:")
        .replace("| New | `brief` + `content` |", "| New | `brief` • `content` |")
        .replace("| New | `brief` \\+ `content` |", "| New | `brief` • `content` |")
        .replace("\n- \n", "\n<ul>\n<li></li>\n</ul>\n") + "\n",
  })
  f.skills.clear()
  f.files.clear()
  f.base.records.clear()
  const calls: Array<{ path: string; method: string; body: unknown }> = []
  const errors: string[] = []
  const commands: unknown[] = []
  let gitRequests = 0
  let rejectOnboardingMainReadback = false
  let rejectOnboardingReferenceReadback = false
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      const chunks: Buffer[] = []
      for await (const chunk of request)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      const bytes = Buffer.concat(chunks)
      if (url.pathname.startsWith("/origin.git/")) {
        gitRequests++
        const child = spawn("git", ["http-backend"], {
          env: {
            ...gitEnv,
            GIT_PROJECT_ROOT: directory,
            GIT_HTTP_EXPORT_ALL: "1",
            PATH_INFO: url.pathname,
            QUERY_STRING: url.search.slice(1),
            REQUEST_METHOD: request.method ?? "GET",
            CONTENT_TYPE: String(request.headers["content-type"] ?? ""),
            CONTENT_LENGTH: String(bytes.length),
            GIT_PROTOCOL: String(request.headers["git-protocol"] ?? ""),
          },
          stdio: ["pipe", "pipe", "pipe"],
        })
        child.stdin.end(bytes)
        const output: Buffer[] = [],
          stderr: Buffer[] = []
        child.stdout.on("data", (value: Buffer) => output.push(value))
        child.stderr.on("data", (value: Buffer) => stderr.push(value))
        const exit = await new Promise<number | null>((resolve, reject) => {
          child.on("error", reject)
          child.on("close", resolve)
        })
        if (exit !== 0) throw new Error(`Git backend: ${Buffer.concat(stderr).toString()}`)
        const raw = Buffer.concat(output),
          split = raw.indexOf("\r\n\r\n")
        if (split < 0) throw new Error("Git backend did not provide CGI headers")
        for (const line of raw.subarray(0, split).toString().split("\r\n")) {
          const colon = line.indexOf(":")
          if (colon < 0) throw new Error("Invalid CGI header")
          const name = line.slice(0, colon),
            value = line.slice(colon + 1).trim()
          if (name.toLowerCase() === "status") response.statusCode = Number(value.slice(0, 3))
          else response.setHeader(name, value)
        }
        response.end(raw.subarray(split + 4))
        return
      }
      const method = request.method
      if (method !== "GET" && method !== "POST" && method !== "PATCH")
        throw new Error(`Unexpected method ${method}`)
      const body: unknown = bytes.length === 0 ? undefined : JSON.parse(bytes.toString())
      calls.push({ path: url.pathname, method, body })
      if (url.pathname === "/v1/users/me")
        return json(response, 200, {
          object: "user",
          id: id(99),
          type: "bot",
          bot: { workspace_id: id(100) },
        })
      const parent = property(property(body).parent).data_source_id
      if (
        url.pathname === "/v1/pages" &&
        method === "POST" &&
        (parent === library.skills.data_source_id || parent === library.files.data_source_id)
      ) {
        const db = new Database(join(state, "state.sqlite"), { readonly: true })
        try {
          const rows = db
            .query(
              "SELECT key,payload FROM shared_local_records WHERE category='dispatch' AND retired=0 AND key LIKE 'operations/shared-native-create/%'",
            )
            .all()
            .map(property)
          if (rows.length === 0) throw new Error("Native creation preceded its durable journal")
          for (const row of rows)
            f.base.json.set(field(row, "key"), JSON.parse(field(row, "payload")))
        } finally {
          db.close()
        }
      }
      const page = url.pathname.startsWith("/v1/pages/")
        ? f.skills.get(url.pathname.slice(10))
        : undefined
      const bodyPage = /^\/v1\/pages\/([^/]+)\/markdown$/u.exec(url.pathname)?.[1]
      if (method === "PATCH" && bodyPage !== undefined && f.base.bodies.has(bodyPage)) {
        const updates = property(property(body).update_content).content_updates
        if (
          property(body).type !== "update_content" ||
          property(body).markdown_version !== "v2" ||
          !Array.isArray(updates) ||
          updates.length !== 1
        )
          throw new Error("Expected one complete original-body update")
        const change = property(updates[0])
        if (change.old_str !== f.base.bodies.get(bodyPage) || typeof change.new_str !== "string")
          throw new Error("The reviewed full preimage changed")
        const observed =
          change.new_str
            .replace("| New | `brief` + `content` |", "| New | `brief` • `content` |")
            .replace("| New | `brief` \\+ `content` |", "| New | `brief` • `content` |") + "\n"
        f.base.bodies.set(bodyPage, observed)
        return json(response, 200, {
          object: "page_markdown",
          id: bodyPage,
          markdown: observed,
          truncated: false,
          unknown_block_ids: [],
        })
      }
      const changes = property(property(body).properties)
      if (
        method === "PATCH" &&
        page !== undefined &&
        Object.keys(changes).sort().join(",") ===
          [library.skills.property_ids.Origin, library.skills.property_ids["Source Member"]]
            .sort()
            .join(",")
      ) {
        for (const [key, value] of Object.entries(changes)) {
          const previous = property(property(page.properties)[key])
          property(page.properties)[key] = { ...previous, ...property(value) }
        }
        return json(response, 200, page)
      }
      const result = await f.run(
        Effect.flatMap(Notion, (api) =>
          api.request(url.pathname.slice(1) + url.search, body, { method }),
        ),
      )
      const observedPage = f.skills.get(
        url.pathname.replace(/^\/v1\/pages\//u, "").replace(/\/markdown$/u, ""),
      )
      if (
        rejectOnboardingMainReadback &&
        method === "GET" &&
        url.pathname.endsWith("/markdown") &&
        text(property(property(observedPage?.properties).title).title) === "existing-candidate"
      )
        return json(response, 200, {
          ...property(result),
          markdown: "# Controlled rejected main observation\n",
        })
      const observedFile = f.files.get(
        url.pathname.replace(/^\/v1\/pages\//u, "").replace(/\/markdown$/u, ""),
      )
      if (
        rejectOnboardingReferenceReadback &&
        method === "GET" &&
        url.pathname.endsWith("/markdown") &&
        text(property(property(observedFile?.properties).path).rich_text) ===
          "references/a-original.md"
      )
        return json(response, 200, {
          ...property(result),
          markdown: "# Controlled previous reference readback rejection\n",
        })
      return json(response, 200, result)
    } catch (error) {
      errors.push(String(error))
      json(response, 400, { object: "error", code: "validation_error", message: String(error) })
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("Expected a loopback server")
  const origin = `http://127.0.0.1:${address.port}`
  const definition = {
    version: 1 as const,
    source_id: "member-lifecycle",
    name: "Member lifecycle",
    description: "Controlled Git source",
    enabled: true,
    policy: "manual" as const,
    adapter: { type: "git" as const, url: `${origin}/origin.git`, ref: "main" },
    selection: { roots: ["skills"], include: [], exclude: [], mapping: {} },
    options: {},
  }
  for (const [key, value] of Object.entries(sourceDefinitionPropertiesFor(library, definition)))
    f.source.properties[key] = { ...property(f.source.properties[key]), ...property(value) }
  const nodeShim = Bun.which("node")
  if (nodeShim === null) throw new Error("Node is required")
  const node = execFileSync(nodeShim, ["--print", "process.execPath"], { encoding: "utf8" }).trim()
  const env = {
    ...gitEnv,
    HOME: join(directory, "home"),
    NOTION_API_TOKEN: "controlled-member-token",
    NOTION_API_BASE_URL: origin,
    NOTION_WORKSPACE_ID: "",
    NTN_SKILLS_HOME: state,
    NTN_SKILLS_CONFIG_HOME: join(directory, "config"),
    NTN_SKILLS_CACHE_HOME: join(directory, "cache"),
    NTN_SKILLS_DATA_HOME: join(directory, "data"),
    NTN_SKILLS_SCHEDULER_ROOT: join(directory, "scheduler"),
    NTN_SKILLS_NOTION_INTERVAL_MS: "100",
    NTN_SKILLS_DEV_ROOT: undefined,
  }
  const invoke = async (args: string[], exits = [0], cold = false) => {
    const child = Bun.spawn([node, executable, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: cold
        ? {
            ...env,
            NTN_SKILLS_HOME: join(directory, "cold-state"),
            NTN_SKILLS_CACHE_HOME: join(directory, "cold-cache"),
            NTN_SKILLS_DATA_HOME: join(directory, "cold-data"),
          }
        : env,
    })
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(errors, stdout + stderr).toEqual([])
    expect(exits, stdout + stderr).toContain(exit)
    const output = property(JSON.parse(stdout))
    // Bun 1.4 nested asymmetric toMatchObject currently mutates matched objects.
    // Keep the transport receipt and later argv/identity observations outside
    // that mutable matcher input, even when a test checks a deep partial shape.
    const commandIndex = String(commands.length + 1).padStart(3, "0")
    await writeFile(join(directory, `command-${commandIndex}.stdout.json`), stdout)
    commands.push({
      args,
      exit,
      cold,
      output: structuredClone(output),
      stderr,
      stdout_file: `command-${commandIndex}.stdout.json`,
      stdout_sha256: hash(new TextEncoder().encode(stdout)),
    })
    await writeFile(join(directory, "commands.json"), JSON.stringify(commands, null, 2) + "\n")
    return output
  }
  const sources = ["ctl", "library", "sources"]
  const entry = ["--entry", library.skills.database_id]
  const writes = () =>
    calls.filter(
      (call) => call.method === "PATCH" || (call.method === "POST" && call.path === "/v1/pages"),
    )
  try {
    const check = await invoke([...sources, "check", f.source.id, ...entry])
    expect(check.revision).toBe(firstRevision)
    expect(check.members).toEqual(
      expect.arrayContaining([expect.objectContaining({ member_key: "skills/fresh", files: 3 })]),
    )
    expect(writes()).toHaveLength(0)
    expect(f.skills.size).toBe(0)
    const admission = join(directory, "admission.json")
    await invoke([
      ...sources,
      "admit",
      f.source.id,
      ...entry,
      "--member",
      "skills/fresh",
      "--skill-id",
      "explicit-member",
      "--output",
      admission,
    ])
    const plan = property(JSON.parse(await readFile(admission, "utf8")))
    expect(plan.enabled).toBe(false)
    expect(plan.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ projection: expect.objectContaining({ version: 14 }) }),
      ]),
    )
    expect(writes()).toHaveLength(0)
    await invoke([...sources, "admit-apply", admission, ...entry, "--dry-run"])
    expect(writes()).toHaveLength(0)
    const admitted = await invoke([...sources, "admit-apply", admission, ...entry])
    expect(admitted.verified).toBe(true)
    const pageId = field(admitted, "skill_page_id"),
      page = f.skills.get(pageId)
    if (page === undefined) throw new Error("Expected admitted page")
    expect(f.skills.size).toBe(1)
    expect(property(property(page.properties).enabled).checkbox).toBe(false)
    const beforeRepeat = writes().length,
      providerBeforeRepeat = gitRequests
    expect((await invoke([...sources, "admit-apply", admission, ...entry])).reused).toBe(true)
    expect((await invoke([...sources, "admit-reconcile", admission, ...entry])).verified).toBe(true)
    expect(writes()).toHaveLength(beforeRepeat)
    expect(gitRequests).toBe(providerBeforeRepeat)
    const duplicate = await invoke(
      [
        ...sources,
        "admit",
        f.source.id,
        ...entry,
        "--member",
        "skills/fresh",
        "--skill-id",
        "must-not-duplicate",
        "--output",
        join(directory, "duplicate.json"),
      ],
      [1],
    )
    expect(duplicate).toMatchObject({ ok: false, error: { code: "SOURCE_MEMBER_ALREADY_BOUND" } })
    expect(f.skills.size).toBe(1)
    expect(writes()).toHaveLength(beforeRepeat)
    const originalRead = await invoke(
      ["read", pageId, "--database", library.skills.database_id, "--authoring"],
      [0],
      true,
    )
    const pin = field(originalRead, "snapshot_id")
    const originalText = field(originalRead, "content")
    expect(originalText).toContain("##### Detailed instruction")
    expect(f.base.bodies.get(pageId)).toContain("### Detailed instruction")

    const guidePage = [...f.files.values()].find(
      (row) => text(property(property(row.properties).path).rich_text) === "references/guide.md",
    )
    if (typeof guidePage?.id !== "string") throw new Error("Expected guide page")
    const custom = "# Custom guide\n\nKeep the author's additional instruction.\n"
    f.base.bodies.set(guidePage.id, custom)
    await invoke(["read", pageId, "--database", library.skills.database_id, "--authoring"])
    const selected = structuredClone(property(page.properties).source)
    const preserved = () =>
      Object.fromEntries(
        Object.entries(property(page.properties)).filter(
          ([key]) => key !== "origin" && key !== "source_member",
        ),
      )
    const metadata = structuredClone(preserved()),
      bodies = new Map(f.base.bodies)
    git(work, "mv", "skills/fresh", "skills/renamed")
    const secondRevision = commit()
    const changed = await invoke([...sources, "check", f.source.id, ...entry])
    expect(changed.revision).toBe(secondRevision)
    expect(text(property(property(page.properties).source_member).rich_text)).toBe("skills/fresh")
    const move = join(directory, "move.json")
    await invoke([
      ...sources,
      "member-prepare",
      f.source.id,
      ...entry,
      "--target",
      pageId,
      "--member",
      "skills/renamed",
      "--output",
      move,
    ])
    expect((await invoke([...sources, "member-apply", move, ...entry])).verified).toBe(true)
    expect(text(property(property(page.properties).source_member).rich_text)).toBe("skills/renamed")
    expect(preserved()).toEqual(metadata)
    expect(f.base.bodies).toEqual(bodies)
    const afterMove = writes().length
    expect((await invoke([...sources, "member-reconcile", move, ...entry])).verified).toBe(true)
    expect((await invoke([...sources, "member-apply", move, ...entry])).verified).toBe(true)
    expect(writes()).toHaveLength(afterMove)

    await rename(join(work, "skills/renamed"), join(directory, "removed-member"))
    const thirdRevision = commit()
    const removed = await invoke([...sources, "check", f.source.id, ...entry])
    expect(removed.revision).toBe(thirdRevision)
    const retain = join(directory, "retain.json")
    await invoke([
      ...sources,
      "member-prepare",
      f.source.id,
      ...entry,
      "--target",
      pageId,
      "--retain-removed",
      "--output",
      retain,
    ])
    expect((await invoke([...sources, "member-apply", retain, ...entry])).verified).toBe(true)
    expect(property(property(page.properties).origin).relation).toEqual([])
    expect(property(page.properties).source).toEqual(selected)
    expect(preserved()).toEqual(metadata)
    expect(f.base.bodies).toEqual(bodies)
    const beforeCold = writes().length,
      beforeColdGit = gitRequests
    const current = await invoke(
      ["read", pageId, "--database", library.skills.database_id, "--authoring"],
      [0],
      true,
    )
    const output = join(directory, "export")
    await invoke(
      [
        "export",
        field(current, "snapshot_id"),
        "--offline",
        "--projection",
        "snapshot",
        "--output",
        output,
      ],
      [0],
      true,
    )
    expect(await readFile(join(output, "references/guide.md"), "utf8")).toBe(custom)
    expect(hash(await readFile(join(output, "assets/data.bin")))).toBe(hash(originalBinary))
    expect(field(await invoke(["read", pin, "--offline"], [0], true), "content")).toBe(originalText)
    expect((await invoke([...sources, "member-reconcile", retain, ...entry])).verified).toBe(true)
    expect(writes()).toHaveLength(beforeCold)
    expect(gitRequests).toBe(beforeColdGit)
    const legacyLateReadWrites = writes().length - beforeCold

    // Reuse the real Git + Node/SQLite harness for the new public handoff. The
    // originally unselected base member is still absent; no observer seeds it.
    const onboard = join(directory, "onboarding.json")
    const reviewed = await invoke([...sources, "review", "--source", f.source.id, ...entry])
    expect(reviewed.remote_writes).toBe(0)
    expect(reviewed.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          members: [expect.objectContaining({ kind: "admit", member_key: "skills/base" })],
        }),
      ]),
    )
    const prepared = await invoke([
      ...sources,
      "onboard",
      "--source",
      f.source.id,
      ...entry,
      "--output",
      onboard,
      "--storage",
      "retained",
    ])
    expect(prepared.actions).toEqual([
      expect.objectContaining({ kind: "create", member: "skills/base", enabled: false }),
    ])
    expect(
      (await invoke([...sources, "onboard-apply", onboard, ...entry, "--dry-run"])).status,
    ).toBe("previewed")
    expect(writes()).toHaveLength(beforeCold)
    const originalPlanBytes = await readFile(onboard)
    rejectOnboardingMainReadback = true
    const refusedMain = await invoke([...sources, "onboard-apply", onboard, ...entry], [3])
    expect(structuredClone(refusedMain)).toMatchObject({
      status: "partial",
      results: [
        expect.objectContaining({
          verified: false,
          error: expect.objectContaining({
            code: "SHARED_CREATE_BODY_MISMATCH",
            details: expect.objectContaining({ stage: "manifest" }),
          }),
        }),
      ],
    })
    const allocatedBase = [...f.skills.values()].find(
      (row) => text(property(property(row.properties).title).title) === "existing-candidate",
    )
    expect(allocatedBase).toBeDefined()
    const allocatedBaseId = String(allocatedBase!.id)
    const originalCorruptedBase = f.base.bodies.get(allocatedBaseId)
    expect(originalCorruptedBase).toContain("•")
    const stoppedWrites = writes().length
    rejectOnboardingMainReadback = false
    const incomplete = await invoke([...sources, "onboard-reconcile", onboard, ...entry], [3])
    const next = property(incomplete.next)
    expect(next).toMatchObject({
      read_only: true,
      argv: ["ntn-skills", ...sources, "onboard-apply", onboard, ...entry, "--dry-run"],
    })
    const route = next.argv
    if (!Array.isArray(route)) throw new Error("Expected exact original preview argv")
    const exactArgs = route.map((item) => {
      if (typeof item !== "string")
        throw new Error("Expected a string argv without shell interpolation")
      return item
    })
    await invoke(exactArgs.slice(1))
    expect(writes()).toHaveLength(stoppedWrites)
    const mainResults = refusedMain.results
    if (!Array.isArray(mainResults) || mainResults.length !== 1)
      throw new Error("Expected one original main refusal")
    const repairOperation = field(mainResults[0], "operation_id")
    const repairFile = join(directory, "main-projection-repair.json")
    const mainReview = await invoke([
      ...sources,
      "recovery",
      "repair",
      "review",
      onboard,
      "--operation",
      repairOperation,
      "--target",
      allocatedBaseId,
      ...entry,
      "--output",
      repairFile,
    ])
    const repairId = field(mainReview, "review_id")
    expect(property(mainReview.candidate).policy).toBe(17)
    expect(mainReview.remote_writes).toBe(0)
    expect(Object.hasOwn(mainReview, "review")).toBe(false)
    await invoke([
      ...sources,
      "recovery",
      "repair",
      "apply",
      onboard,
      "--operation",
      repairOperation,
      ...entry,
      "--review",
      repairFile,
      "--review-id",
      repairId,
      "--dry-run",
    ])
    expect(writes()).toHaveLength(stoppedWrites)
    const repairProbe = join(directory, "repair-sdk.mjs")
    await writeFile(
      repairProbe,
      `
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {applySourceProjectionRepair,reconcileSourceProjectionRepair} from ${JSON.stringify(pathToFileURL(join(dirname(executable), "sdk.js")).href)};
const plan=JSON.parse(await readFile(${JSON.stringify(onboard)},"utf8"));
const review=JSON.parse(await readFile(${JSON.stringify(repairFile)},"utf8"));
const input={entry:${JSON.stringify(library.skills.database_id)},plan,operationId:${JSON.stringify(repairOperation)},review,reviewId:${JSON.stringify(repairId)}};
const applied=await applySourceProjectionRepair(input);assert.equal(applied.result.verified,true);assert.equal(applied.result.original_creation_completed,false);
const repeated=await applySourceProjectionRepair(input);assert.equal(repeated.result.remote_writes,0);
const coldEnv={...process.env,NTN_SKILLS_HOME:${JSON.stringify(join(directory, "repair-cold-state"))},NTN_SKILLS_CACHE_HOME:${JSON.stringify(join(directory, "repair-cold-cache"))},NTN_SKILLS_DATA_HOME:${JSON.stringify(join(directory, "repair-cold-data"))}};
const metrics=[];const cold=await reconcileSourceProjectionRepair(input,{env:coldEnv,onRequestMetrics:m=>metrics.push(m)});
assert.equal(cold.result.verified,true);assert.ok(metrics.every(m=>m.requests.notion_write===0));
console.log(JSON.stringify({applied,repeated,cold,metrics,originalAuthorStoreCopied:false}));
`,
    )
    const repairChild = Bun.spawn([node, repairProbe], {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [repairOut, repairErr, repairExit] = await Promise.all([
      new Response(repairChild.stdout).text(),
      new Response(repairChild.stderr).text(),
      repairChild.exited,
    ])
    expect(repairExit, repairOut + repairErr).toBe(0)
    const repairProof = property(JSON.parse(repairOut))
    await writeFile(join(directory, "repair-sdk.json"), JSON.stringify(repairProof, null, 2))
    expect(
      (
        await invoke([
          ...sources,
          "recovery",
          "repair",
          "reconcile",
          onboard,
          "--operation",
          repairOperation,
          ...entry,
          "--review",
          repairFile,
          "--review-id",
          repairId,
        ])
      ).verified,
    ).toBe(true)
    expect(
      calls.filter(
        (call) => call.method === "PATCH" && call.path === `/v1/pages/${allocatedBaseId}/markdown`,
      ),
    ).toHaveLength(1)
    const originalBaseBody = f.base.bodies.get(allocatedBaseId)
    expect(originalBaseBody).not.toContain("•")
    expect(await readFile(onboard)).toEqual(originalPlanBytes)
    rejectOnboardingReferenceReadback = true
    const refusedReference = await invoke([...sources, "onboard-apply", onboard, ...entry], [3])
    const failures = refusedReference.results
    if (!Array.isArray(failures) || failures.length !== 1)
      throw new Error("Expected the original base operation")
    const originalOperation = field(failures[0], "operation_id")
    expect(property(property(failures[0]).error)).toMatchObject({
      code: "SHARED_CREATE_BODY_MISMATCH",
      details: expect.objectContaining({ path: "references/a-original.md" }),
    })
    rejectOnboardingReferenceReadback = false
    const terminal = await invoke([...sources, "onboard-apply", onboard, ...entry], [3])
    expect(structuredClone(terminal)).toMatchObject({
      results: [
        expect.objectContaining({
          error: expect.objectContaining({ code: "SHARED_CREATE_REVIEW_REQUIRED" }),
        }),
      ],
    })
    const beforeReview = writes().length
    const recoveryFile = join(directory, "retained-recovery-review.json")
    const reviewedRecovery = await invoke([
      ...sources,
      "recovery",
      "review",
      onboard,
      "--operation",
      originalOperation,
      "--target",
      allocatedBaseId,
      ...entry,
      "--output",
      recoveryFile,
    ])
    const recoveryId = field(reviewedRecovery, "review_id")
    expect(writes()).toHaveLength(beforeReview)
    await invoke([
      ...sources,
      "recovery",
      "apply",
      onboard,
      "--operation",
      originalOperation,
      ...entry,
      "--review",
      recoveryFile,
      "--review-id",
      recoveryId,
      "--dry-run",
    ])
    expect(writes()).toHaveLength(beforeReview)
    const sdkPath = pathToFileURL(join(dirname(executable), "sdk.js")).href
    const sdkProbe = join(directory, "onboarding-sdk.mjs")
    await writeFile(
      sdkProbe,
      `
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { applySourceRecovery, reconcileSourceRecovery, reconcileSourceOnboarding, reviewSources, prepareSourceOnboarding, readSkill, listSkill } from ${JSON.stringify(sdkPath)};
const entry = ${JSON.stringify(library.skills.database_id)};
const plan = JSON.parse(await readFile(${JSON.stringify(onboard)}, "utf8"));
const review = JSON.parse(await readFile(${JSON.stringify(recoveryFile)}, "utf8"));
const operationId = ${JSON.stringify(originalOperation)};
const applied = await applySourceRecovery({ entry, plan, operationId, review, reviewId: ${JSON.stringify(recoveryId)} });
assert.equal(applied.result.verified, true);
const originalResult = await reconcileSourceRecovery({ entry, plan, operationId, target: ${JSON.stringify(allocatedBaseId)} });
assert.equal(originalResult.result.verified, true);
const reconciled = await reconcileSourceOnboarding({ entry, plan });
assert.equal(reconciled.result.status, "completed");
const input = { entry, scope: { kind: "source", source: ${JSON.stringify(f.source.id)} } };
const reviewed = await reviewSources(input);
assert.equal(reviewed.result.sources[0].members[0].kind, "registered");
const repeated = await prepareSourceOnboarding(input);
assert.equal(repeated.result.actions.length, 0);
const coldEnv = { ...process.env, NTN_SKILLS_HOME: ${JSON.stringify(join(directory, "cold-sdk-state"))},
  NTN_SKILLS_CACHE_HOME: ${JSON.stringify(join(directory, "cold-sdk-cache"))}, NTN_SKILLS_DATA_HOME: ${JSON.stringify(join(directory, "cold-sdk-data"))} };
const metrics=[];
const cold=await readSkill(${JSON.stringify(allocatedBaseId)}, { env:coldEnv, database:entry, authoring:true, readOnly:true, onRequestMetrics:m=>metrics.push(m) });
const files=await listSkill(cold.snapshot_id,{env:coldEnv,offline:true});
assert.equal(files.files.length,3);
assert.equal(cold.record.enabled,false);
assert.ok(metrics.every(m=>m && m.requests.notion_write===0));
console.log(JSON.stringify({ applied, originalResult, reconciled, reviewed, repeatedActions: repeated.result.actions.length,
  cold:{snapshot_id:cold.snapshot_id,files:files.files,metrics,originalAuthorStoreCopied:false} }));
`,
    )
    const sdkChild = Bun.spawn([node, sdkProbe], {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [sdkOut, sdkErr, sdkExit] = await Promise.all([
      new Response(sdkChild.stdout).text(),
      new Response(sdkChild.stderr).text(),
      sdkChild.exited,
    ])
    expect(sdkExit, sdkOut + sdkErr).toBe(0)
    expect(errors).toEqual([])
    const sdkResult = property(JSON.parse(sdkOut))
    await writeFile(join(directory, "onboarding-sdk.json"), JSON.stringify(sdkResult, null, 2))
    expect(f.skills.size).toBe(2)
    expect(f.skills.has(allocatedBaseId)).toBe(true)
    expect(f.base.bodies.get(allocatedBaseId)).toBe(originalBaseBody)
    expect(await readFile(onboard)).toEqual(originalPlanBytes)
    expect(
      calls.filter(
        (call) =>
          call.method === "POST" &&
          call.path === "/v1/pages" &&
          text(property(property(property(call.body).properties)[skillPropertyIds.Name!]).title) ===
            "existing-candidate",
      ),
    ).toHaveLength(1)
    const basePage = [...f.skills.values()].find(
      (row) => text(property(property(row.properties).title).title) === "existing-candidate",
    )
    expect(property(property(basePage?.properties).enabled).checkbox).toBe(false)
    const afterOnboarding = writes().length
    expect((await invoke([...sources, "onboard-reconcile", onboard, ...entry])).status).toBe(
      "completed",
    )
    expect((await invoke([...sources, "onboard-apply", onboard, ...entry])).status).toBe(
      "completed",
    )
    expect(
      (
        await invoke([
          ...sources,
          "recovery",
          "reconcile",
          onboard,
          "--operation",
          originalOperation,
          "--target",
          allocatedBaseId,
          ...entry,
        ])
      ).verified,
    ).toBe(true)
    expect(writes()).toHaveLength(afterOnboarding)
    expect(preserved()).toEqual(metadata)
    for (const [page, body] of bodies) expect(f.base.bodies.get(page)).toBe(body)
    const evidence = process.env.NTN_SOURCE_MEMBERS_EVIDENCE_DIR
    if (evidence) {
      await mkdir(evidence, { recursive: true })
      await writeFile(
        join(evidence, "receipt.json"),
        JSON.stringify(
          {
            kind: "public_node_cli_real_git_controlled_notion",
            actual_notion: false,
            controlled_journey_deadline_ms: 300_000,
            controlled_notion_interval_ms: 100,
            cli_sha256: hash(await readFile(executable)),
            command_directory: directory,
            revisions: [firstRevision, secondRevision, thirdRevision],
            page_id: pageId,
            selected,
            raw_resource_sha256: hash(originalBinary),
            custom_preserved: true,
            original_pin_preserved: true,
            late_reads_writes: legacyLateReadWrites,
            onboarding: {
              cli_preview: true,
              rejected_main_original_page_resumed: allocatedBaseId,
              original_plan_bytes_preserved: true,
              original_table_literal_repair: {
                review_id: repairId,
                one_original_page_patch: true,
                sdk: repairProof,
              },
              reconcile_routes_to_readonly_original_preview: true,
              known_terminal_explicitly_reviewed: recoveryId,
              original_failed_operation: originalOperation,
              sdk_same_plan: true,
              repeated_writes: writes().length - afterOnboarding,
              sdk: sdkResult,
            },
            native_pages_created: f.nativeCreates().length,
            total_commands: commands.length,
            git_http_requests: gitRequests,
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
  // This joined journey now contains original admission, failed-main continuation,
  // persisted-terminal review, SDK recovery, cold read and repeated reconciliation.
  // Keep all stages and the real 100 ms scheduler; this is a harness wall-time
  // ceiling, not a change to product request or natural-model budgets.
}, 300_000)
