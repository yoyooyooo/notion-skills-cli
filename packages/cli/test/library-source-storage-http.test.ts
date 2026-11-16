import { expect, test } from "bun:test"
import { Effect } from "effect"
import { createServer } from "node:http"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, writeFile, chmod } from "node:fs/promises"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import { createHash } from "node:crypto"
import {
  fixture,
  library,
  ids,
  input as sourceInput,
} from "../../core/test/shared-source-projection-fixture.ts"
import { prepareSharedSourceProjection } from "../../core/src/shared-source-projection.ts"
import {
  readSourceDefinition,
  sourceDefinitionPropertiesFor,
} from "../../core/src/shared-source-definitions.ts"
import { executeSharedCreate } from "../../core/src/shared-create.ts"
import { Notion } from "../../core/src/notion.ts"
import { property, text } from "../../core/src/model.ts"
import { rich, id } from "../../core/test/shared-snapshot-fixture.ts"

const executable =
  process.env.NTN_SKILLS_TEST_EXECUTABLE ??
  new URL("../dist/ntn-skills.js", import.meta.url).pathname
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")
const field = (input: unknown, name: string) => {
  const value = property(input)[name]
  if (typeof value !== "string") throw new Error("Expected " + name)
  return value
}

test("independent CLI and SDK align an original disabled retained tree to identical pinned Git with no byte uploads or page replacements", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntn-storage-install-")),
    work = join(root, "work"),
    repository = join(root, "source.git")
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Storage fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.test",
    GIT_COMMITTER_NAME: "Storage fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.test",
  }
  await mkdir(work)
  const git = (directory: string, args: string[]) =>
    execFileSync("git", ["-C", directory, ...args], {
      env: gitEnv,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
  git(work, ["init", "-b", "main"])
  const f = fixture([], { markdownImport: true, recovery: true })
  const acquired = f.snapshot,
    m = acquired.members[0]!
  for (const file of m.portable.files) {
    const path = join(work, "skills/demo", file.path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, file.bytes)
    await chmod(path, file.path.endsWith(".js") ? 0o755 : 0o644)
  }
  await mkdir(join(work, "not-selected"))
  await writeFile(join(work, "not-selected/extra.bin"), new Uint8Array(1024 * 1024).fill(19))
  git(work, ["add", "."])
  git(work, ["commit", "--no-gpg-sign", "-m", "original fixed storage"])
  const commit = git(work, ["rev-parse", "HEAD"]),
    tree = git(work, ["rev-parse", "HEAD^{tree}"])
  const manifest = m.portable.files.map((file) => ({
    path: file.path,
    source_path: "skills/demo/" + file.path,
    git_oid: git(work, ["rev-parse", commit + ":skills/demo/" + file.path]),
    bytes: file.bytes.length,
    mode: file.path.endsWith(".js") ? ("100755" as const) : ("100644" as const),
  }))
  Object.assign(acquired, {
    revision: commit,
    provenance: {
      ...acquired.provenance,
      git_url: "https://github.com/example/storage-alignment.git",
    },
  })
  Object.assign(m, { git_manifest: { commit, tree, root: "skills/demo", files: manifest } })
  const definition = {
    ...sourceInput,
    adapter: {
      type: "git" as const,
      url: "https://github.com/example/storage-alignment.git",
      ref: "main",
    },
  }
  for (const [key, value] of Object.entries(sourceDefinitionPropertiesFor(library, definition)))
    f.source.properties[key] = { ...property(f.source.properties[key]), ...property(value) }
  for (const row of f.skills.values()) {
    property(row.properties).origin = {
      id: "origin",
      type: "relation",
      relation: [],
      has_more: false,
    }
    property(row.properties).source_member = rich("source_member", "")
  }
  const originalPlan = await f.run(
    Effect.gen(function* () {
      return yield* prepareSharedSourceProjection({
        library,
        definition: yield* readSourceDefinition(library, f.source.id),
        acquired,
        member: "skills/demo",
        enabled: false,
        markdownImport: true,
        storage: "retained",
        skillId: "original-installed-storage",
      })
    }),
  )
  const created = await f.run(executeSharedCreate(library, { plan: originalPlan, mode: "create" }))
  expect(created.verified).toBe(true)
  const page = created.skill_page_id,
    originalMain = structuredClone(f.skills.get(page)!),
    oldBodies = new Map(f.base.bodies),
    oldRecordIds = new Set(f.base.records.keys()),
    originalPages = f.skills.size + f.files.size
  const oldPin = text(property(property(originalMain.properties).source).rich_text)
  await writeFile(
    join(work, "skills/demo/scripts/run.js"),
    "later HEAD must not enter original alignment\n",
  )
  git(work, ["add", "."])
  git(work, ["commit", "--no-gpg-sign", "-m", "new unrelated source head"])
  git(root, ["clone", "--bare", work, repository])
  git(repository, ["config", "uploadpack.allowFilter", "true"])
  git(repository, ["config", "uploadpack.allowAnySHA1InWant", "true"])
  const config = join(root, "gitconfig")
  await writeFile(
    config,
    `[url "${pathToFileURL(repository).href}"]\n\tinsteadOf = https://github.com/example/storage-alignment.git\n`,
  )
  const calls: { path: string; method: string; body: unknown }[] = []
  let githubReads = 0,
    githubCredentialLeaks = 0
  let loseSelection = false
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, "http://127.0.0.1"),
        method = request.method ?? "GET",
        chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const bytes = Buffer.concat(chunks),
        body = bytes.length === 0 ? undefined : JSON.parse(bytes.toString("utf8"))
      calls.push({ path: url.pathname, method, body })
      if (url.pathname.startsWith("/github-api/")) {
        githubReads++
        if (request.headers.authorization !== undefined || request.headers.cookie !== undefined)
          githubCredentialLeaks++
        const prefix = "/github-api/repos/example/storage-alignment/git/"
        let github: unknown
        if (url.pathname === prefix + "commits/" + commit)
          github = { sha: commit, tree: { sha: tree } }
        else if (url.pathname === prefix + "trees/" + tree && url.search === "?recursive=1")
          github = {
            sha: tree,
            truncated: false,
            tree: [
              { path: "skills/demo", mode: "040000", type: "tree", sha: "c".repeat(40) },
              ...manifest.map((file) => ({
                path: file.source_path,
                mode: file.mode,
                type: "blob",
                sha: file.git_oid,
                size: file.bytes,
              })),
            ],
          }
        else {
          const file = manifest.find((file) => url.pathname === prefix + "blobs/" + file.git_oid)
          if (file) {
            const original = m.portable.files.find((value) => value.path === file.path)!
            github = {
              sha: file.git_oid,
              size: file.bytes,
              encoding: "base64",
              content: Buffer.from(original.bytes).toString("base64") + "\n",
            }
          }
        }
        response.writeHead(github === undefined ? 404 : 200, { "content-type": "application/json" })
        response.end(JSON.stringify(github ?? { error: "not_selected" }))
        return
      }
      if (url.pathname === "/v1/users/me") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            object: "user",
            id: id(99),
            type: "bot",
            bot: { workspace_id: id(100) },
          }),
        )
        return
      }
      let result: unknown
      const target = f.skills.get(url.pathname.replace(/^\/v1\/pages\//u, "")),
        record = [...f.base.records.values()].find((row) => url.pathname === `/v1/pages/${row.id}`)
      const changed = property(property(body).properties)
      if (target && method === "PATCH" && Object.keys(changed).join(",") === "source") {
        if (loseSelection) {
          loseSelection = false
          request.socket.destroy()
          return
        }
        property(target.properties).source = {
          id: "source",
          type: "rich_text",
          ...property(changed.source),
        }
        result = structuredClone(target)
      } else if (record && method === "PATCH" && Object.keys(changed).join(",") === "origin") {
        property(record.properties).origin = {
          id: "origin",
          type: "relation",
          ...property(changed.origin),
          has_more: false,
        }
        result = structuredClone(record)
      } else
        result = await f.run(
          Effect.gen(function* () {
            return yield* (yield* Notion).request(url.pathname.slice(1) + url.search, body, {
              method: method === "GET" ? "GET" : method === "PATCH" ? "PATCH" : "POST",
            })
          }),
        )
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify(result))
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json" })
      response.end(
        JSON.stringify({ object: "error", code: "validation_error", message: String(error) }),
      )
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected local HTTP port")
  const node = execFileSync(Bun.which("node")!, ["--print", "process.execPath"], {
    encoding: "utf8",
  }).trim()
  const env: NodeJS.ProcessEnv = {
    ...gitEnv,
    GIT_CONFIG_GLOBAL: config,
    HOME: join(root, "home"),
    NOTION_API_TOKEN: "controlled-storage-token",
    NOTION_API_BASE_URL: `http://127.0.0.1:${address.port}`,
    NOTION_WORKSPACE_ID: "",
    NTN_SKILLS_HOME: join(root, "state"),
    NTN_SKILLS_CONFIG_HOME: join(root, "config"),
    NTN_SKILLS_CACHE_HOME: join(root, "cache"),
    NTN_SKILLS_DATA_HOME: join(root, "data"),
    NTN_SKILLS_NOTION_MIN_INTERVAL_MS: "100",
    NTN_SKILLS_FIXED_GIT_TRANSPORT: "git",
  }
  delete env.NTN_SKILLS_DEV_ROOT
  const commands: unknown[] = []
  const invoke = async (args: string[], exit = 0, selectedEnv = env) => {
    const child = Bun.spawn([node, executable, ...args], {
      env: selectedEnv,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    await writeFile(join(root, `command-${commands.length + 1}.stderr`), err)
    await writeFile(join(root, `command-${commands.length + 1}.stdout.json`), out)
    expect(code, out + err).toBe(exit)
    const output = property(JSON.parse(out))
    commands.push({
      args,
      exit: code,
      output: structuredClone(output),
      stderr: err,
      stdout_sha256: digest(new TextEncoder().encode(out)),
    })
    await writeFile(join(root, "commands.json"), JSON.stringify(commands, null, 2))
    await writeFile(join(root, `command-${commands.length}.stdout.json`), out)
    expect(code, out + err).toBe(exit)
    return output
  }
  const writes = () =>
    calls.filter(
      (call) =>
        call.method === "PATCH" || (call.method === "POST" && !call.path.endsWith("/query")),
    )
  try {
    const command = ["ctl", "library", "sources", "storage"],
      entry = ["--entry", library.skills.database_id],
      planPath = join(root, "storage.json")
    const reviewed = await invoke([...command, "review", "--source", f.source.id, ...entry])
    expect(reviewed.remote_writes).toBe(0)
    expect(reviewed.provider_requests).toBe(0)
    expect(writes()).toHaveLength(0)
    const prepared = await invoke([
      ...command,
      "prepare",
      "--source",
      f.source.id,
      "--target",
      page,
      ...entry,
      "--output",
      planPath,
    ])
    expect(prepared).toMatchObject({
      status: "prepared",
      revision: commit,
      files: 5,
      new_archive_bytes: 0,
      new_binary_objects: 0,
      remote_writes: 0,
    })
    expect(writes()).toHaveLength(0)
    await invoke([...command, "apply", planPath, "--dry-run"])
    expect(writes()).toHaveLength(0)
    const script = join(root, "sdk-align.mjs")
    await writeFile(
      script,
      `
import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {applySourceStorageAlignment,reconcileSourceStorageAlignment} from ${JSON.stringify(pathToFileURL(join(dirname(executable), "sdk.js")).href)};
const plan=JSON.parse(await readFile(${JSON.stringify(planPath)},'utf8'));
const first=await applySourceStorageAlignment({plan});assert.equal(first.result.result.verified,true);assert.equal(first.result.new_archive_bytes,0);
const again=await applySourceStorageAlignment({plan});assert.equal(again.result.result.verified,true);
const observed=await reconcileSourceStorageAlignment({plan});assert.equal(observed.result.remote_writes,0);
console.log(JSON.stringify({first,again,observed}));
`,
    )
    const child = Bun.spawn([node, script], {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, err, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exit, out + err).toBe(0)
    await writeFile(join(root, "sdk-alignment.json"), out)
    const afterWrites = writes().length
    await invoke([...command, "reconcile", planPath])
    await invoke([...command, "apply", planPath])
    expect(writes()).toHaveLength(afterWrites)
    expect(f.skills.size + f.files.size).toBe(originalPages)
    expect(f.base.bodies).toEqual(oldBodies)
    expect(property(property(f.skills.get(page)!.properties).enabled).checkbox).toBe(false)
    const currentPin = text(property(property(f.skills.get(page)!.properties).source).rich_text)
    expect(currentPin).toStartWith("source-")
    expect(currentPin).not.toBe(oldPin)
    const newRecords = [...f.base.records].filter(([key]) => !oldRecordIds.has(key))
    expect(
      newRecords.some(
        ([, row]) => property(property(property(row.properties).kind).select).name === "object",
      ),
    ).toBe(false)
    expect(
      calls.filter((call) => call.method === "PATCH" && call.path === `/v1/pages/${page}`),
    ).toHaveLength(1)
    const coldEnv = {
      ...env,
      NTN_SKILLS_HOME: join(root, "cold-state"),
      NTN_SKILLS_CACHE_HOME: join(root, "cold-cache"),
      NTN_SKILLS_DATA_HOME: join(root, "cold-data"),
    }
    const coldScript = join(root, "cold-read.mjs")
    await writeFile(
      coldScript,
      `
import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {readSkill,listSkill,readResources} from ${JSON.stringify(pathToFileURL(join(dirname(executable), "sdk.js")).href)};
const metrics=[];const options={database:${JSON.stringify(library.skills.database_id)},authoring:true,readOnly:true,onRequestMetrics:m=>metrics.push(m)};
const current=await readSkill(${JSON.stringify(page)},options);assert.equal(current.record.enabled,false);
const listing=await listSkill(current.snapshot_id,{offline:true});assert.equal(listing.files.length,5);
for(const file of listing.files.filter(file=>file.path!=='SKILL.md')){
 const result=await readResources({version:1,refs:[file.ref]},{readOnly:true});assert.equal(result.status,'ready');
 const raw=result.files[0];const bytes=raw.encoding==='base64'?Buffer.from(raw.content,'base64'):Buffer.from(raw.content);
 const expected=${JSON.stringify(m.portable.files.map((file) => ({ path: file.path, sha256: digest(file.bytes) })))}.find(x=>x.path===file.path);
 assert.equal(createHash('sha256').update(bytes).digest('hex'),expected.sha256);
}
assert.ok(metrics.every(m=>m.requests.notion_write===0));console.log(JSON.stringify({snapshot_id:current.snapshot_id,files:listing.files,metrics,authorStoreCopied:false}));
`,
    )
    const cold = Bun.spawn([node, coldScript], {
      env: coldEnv,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [coldOut, coldErr, coldExit] = await Promise.all([
      new Response(cold.stdout).text(),
      new Response(cold.stderr).text(),
      cold.exited,
    ])
    expect(coldExit, coldOut + coldErr).toBe(0)
    await writeFile(join(root, "cold-sdk.json"), coldOut)
    expect(writes()).toHaveLength(afterWrites)
    const gatewayEnv = {
      ...env,
      NTN_SKILLS_FIXED_GIT_TRANSPORT: "auto",
      NTN_SKILLS_GITHUB_API_URL: `http://127.0.0.1:${address.port}/github-api`,
      NTN_SKILLS_GITHUB_TOKEN: "",
      NTN_SKILLS_GITHUB_AUTH: "auto",
      GH_TOKEN: "official-session-must-not-leak",
      NTN_SKILLS_HOME: join(root, "gateway-state"),
      NTN_SKILLS_CACHE_HOME: join(root, "gateway-cache"),
      NTN_SKILLS_DATA_HOME: join(root, "gateway-data"),
    }
    const inspect = await invoke(
      [
        "ctl",
        "library",
        "source",
        "inspect",
        definition.adapter.url,
        "--commit",
        commit,
        "--root",
        "skills/demo",
      ],
      0,
      gatewayEnv,
    )
    expect(property(inspect.source).commit).toBe(commit)
    expect(githubReads).toBe(2)
    const gateway = Bun.spawn([node, coldScript], {
      env: gatewayEnv,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [gatewayOut, gatewayErr, gatewayExit] = await Promise.all([
      new Response(gateway.stdout).text(),
      new Response(gateway.stderr).text(),
      gateway.exited,
    ])
    expect(gatewayExit, gatewayOut + gatewayErr).toBe(0)
    await writeFile(join(root, "gateway-cold-sdk.json"), gatewayOut)
    expect(githubReads).toBe(7)
    expect(githubCredentialLeaks).toBe(0)
    expect(writes()).toHaveLength(afterWrites)
    expect(property(JSON.parse(gatewayOut)).snapshot_id).toBe(
      property(JSON.parse(coldOut)).snapshot_id,
    )
    const gatewayWarm = Bun.spawn([node, coldScript], {
      env: gatewayEnv,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [warmOut, warmErr, warmExit] = await Promise.all([
      new Response(gatewayWarm.stdout).text(),
      new Response(gatewayWarm.stderr).text(),
      gatewayWarm.exited,
    ])
    expect(warmExit, warmOut + warmErr).toBe(0)
    expect(githubReads).toBe(7)
    expect(githubCredentialLeaks).toBe(0)
    expect(writes()).toHaveLength(afterWrites)
    await writeFile(join(root, "gateway-warm-sdk.json"), warmOut)
    const receipt = {
      kind: "independent_cli_sdk_fixed_git_storage_alignment",
      directory: root,
      commit,
      tree,
      originalPage: page,
      oldPin,
      currentPin,
      originalPagesPreserved: true,
      disabledPreserved: true,
      oldBodiesPreserved: true,
      newByteObjects: 0,
      selectionPatches: 1,
      coldAuthorStoreCopied: false,
      files: manifest,
      commands: commands.length,
      actualNotion: false,
      realGit: true,
      realNodeSqlite: true,
      customGithubApi: {
        metadata_reads: 2,
        blob_reads: 5,
        warm_provider_reads: 0,
        official_credential_leaks: githubCredentialLeaks,
        same_snapshot: true,
      },
      cli_sha256: digest(await readFile(executable)),
      sdk_sha256: digest(await readFile(join(dirname(executable), "sdk.js"))),
    }
    await writeFile(join(root, "requests.json"), JSON.stringify(calls, null, 2))
    await writeFile(join(root, "receipt.json"), JSON.stringify(receipt, null, 2))
    if (process.env.NTN_SOURCE_STORAGE_EVIDENCE) {
      await mkdir(process.env.NTN_SOURCE_STORAGE_EVIDENCE, { recursive: true })
      await writeFile(
        join(process.env.NTN_SOURCE_STORAGE_EVIDENCE, "receipt.json"),
        JSON.stringify(receipt, null, 2),
      )
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
}, 180000)
