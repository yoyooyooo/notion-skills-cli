import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { spawn, execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdtemp, mkdir, readFile, writeFile, rename, realpath } from "node:fs/promises"
import { join } from "node:path"
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
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
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
    "---\nname: existing-candidate\ndescription: Never implicitly admitted\n---\n\n# Base\n",
  )
  commit()
  const originalGuide = "# Original guide\n\nKeep the fixed source.\n"
  const originalBinary = new Uint8Array([0, 255, 13, 10, 17])
  await put(
    "skills/fresh/SKILL.md",
    "---\nname: explicit-member\ndescription: Explicit source admission\nlicense: MIT\n---\n\n# New member\n\n##### Detailed instruction\n\nRead [guide](references/guide.md) and retain [bytes](assets/data.bin).\n",
  )
  await put("skills/fresh/references/guide.md", originalGuide)
  await put("skills/fresh/assets/data.bin", originalBinary)
  const firstRevision = commit()
  const f = fixture([], {
    recovery: true,
    readback: (wire) => wire.replace(/<h1>(.*?)<\/h1>/u, "### $1") + "\n",
  })
  f.skills.clear()
  f.files.clear()
  f.base.records.clear()
  const calls: Array<{ path: string; method: string; body: unknown }> = []
  const errors: string[] = []
  const commands: unknown[] = []
  let gitRequests = 0
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
  const node = Bun.which("node")
  if (node === null) throw new Error("Node is required")
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
    const output = property(JSON.parse(stdout))
    commands.push({ args, exit, cold, output, stderr })
    await writeFile(join(directory, "commands.json"), JSON.stringify(commands, null, 2) + "\n")
    expect(errors, stdout + stderr).toEqual([])
    expect(exits, stdout + stderr).toContain(exit)
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
    const evidence = process.env.NTN_SOURCE_MEMBERS_EVIDENCE_DIR
    if (evidence) {
      await mkdir(evidence, { recursive: true })
      await writeFile(
        join(evidence, "receipt.json"),
        JSON.stringify(
          {
            kind: "public_node_cli_real_git_controlled_notion",
            actual_notion: false,
            cli_sha256: hash(await readFile(executable)),
            command_directory: directory,
            revisions: [firstRevision, secondRevision, thirdRevision],
            page_id: pageId,
            selected,
            raw_resource_sha256: hash(originalBinary),
            custom_preserved: true,
            original_pin_preserved: true,
            late_reads_writes: writes().length - beforeCold,
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
}, 180_000)
