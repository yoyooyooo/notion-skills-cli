import { expect, test } from "vitest"
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { Notion } from "../src/notion.ts"
import { canonicalSharedJson, querySharedRecords } from "../src/shared-records.ts"
import { assertImportedMarkdownContent } from "../src/shared-import-markdown.ts"
import { parseYaml } from "../src/yaml.ts"
import { property } from "../src/model.ts"
import {
  failedCurrentTreeOriginal,
  currentTreePortable,
} from "./shared-create-current-tree-fixture.ts"

const cli =
  process.env.NTN_SKILLS_CURRENT_TREE_CLI_ENTRY ??
  new URL("../../cli/dist/ntn-skills.js", import.meta.url).pathname
const sdkPath =
  process.env.NTN_SKILLS_CURRENT_TREE_SDK_ENTRY ??
  new URL("../../cli/src/sdk.ts", import.meta.url).href
const { readSkill, listSkill, readResources } = (await import(
  sdkPath
)) as typeof import("../../cli/src/sdk.ts")

test("public recovery CLI writes independent facts in SQLite, and an empty ordinary SDK verifies the complete legacy tree", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "ntn-current-tree-public-"))
  const { f, plan, page, originalFailure } = await failedCurrentTreeOriginal()
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const raw = Buffer.concat(chunks).toString("utf8")
      const path = request.url!.replace(/^\//u, "")
      const result =
        path === "v1/users/me"
          ? { object: "user", id: "00000000-0000-4000-8000-000000000099" }
          : await f.run(
              Effect.gen(function* () {
                return yield* (yield* Notion).request(
                  path,
                  raw === "" ? undefined : JSON.parse(raw),
                  { method: request.method as "GET" | "POST" | "PATCH" },
                )
              }),
            )
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify(result))
    })().catch((error: unknown) => {
      response.writeHead(500, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          object: "error",
          status: 500,
          code: "internal_server_error",
          message: String(error),
        }),
      )
    })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (address === null || typeof address === "string")
    throw new Error("Controlled HTTP address required")
  const environment = { ...process.env }
  delete environment.NTN_SKILLS_DEV_ROOT
  const base = {
    ...environment,
    NOTION_API_TOKEN: "controlled-independent-tree-author",
    NOTION_API_BASE_URL: `http://127.0.0.1:${address.port}`,
    NTN_SKILLS_HOME: join(root, "writer/state"),
    NTN_SKILLS_CONFIG_HOME: join(root, "writer/config"),
    NTN_SKILLS_CACHE_HOME: join(root, "writer/cache"),
    NTN_SKILLS_DATA_HOME: join(root, "writer/data"),
    NTN_SKILLS_SCHEDULER_ROOT: join(root, "scheduler"),
    NTN_SKILLS_NOTION_INTERVAL_MS: "100",
  }
  const receipts: unknown[] = []
  async function invoke(args: string[]) {
    const worker = spawn(process.execPath, [cli, ...args], {
      env: base,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = "",
      stderr = ""
    worker.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk
    })
    worker.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk
    })
    const [exit] = await once(worker, "close")
    receipts.push({ args, exit, stdout, stderr })
    expect(exit, stdout + stderr).toBe(0)
    return JSON.parse(stdout)
  }
  try {
    const original = join(root, "original-plan.json"),
      reviewed = join(root, "review.json")
    await writeFile(original, JSON.stringify(plan), { flag: "wx" })
    const command = ["ctl", "library", "create", "recovery"]
    const scope = ["--entry", f.library.skills.database_id]
    const budget = ["--max-requests", "2000", "--duration-ms", "180000", "--max-bytes", "16777216"]
    await invoke([
      ...command,
      "review",
      original,
      ...scope,
      "--target",
      page,
      "--accept-current-tree",
      "--output",
      reviewed,
      ...budget,
    ])
    expect(f.writes()).toHaveLength(0)
    const review = JSON.parse(await readFile(reviewed, "utf8"))
    const apply = [
      ...command,
      "apply",
      original,
      ...scope,
      "--review",
      reviewed,
      "--review-id",
      review.review_id,
      ...budget,
    ]
    await invoke([...apply, "--dry-run"])
    expect(f.writes()).toHaveLength(0)
    await invoke(apply)
    expect(f.writes()).toHaveLength(6)
    expect(f.nativeCreates()).toHaveLength(0)
    expect(f.enablePatches()).toHaveLength(0)
    f.clear()
    await invoke([
      ...command,
      "reconcile",
      original,
      ...scope,
      "--target",
      page,
      "--accept-current-tree",
      ...budget,
    ])
    expect(f.writes()).toHaveLength(0)
    const failure = await f.run(
      querySharedRecords(f.library, {
        skillPageId: page,
        kind: "operation",
        recordId: "outcome-" + plan.operation_id,
      }),
    )
    expect(canonicalSharedJson(failure[0])).toBe(originalFailure)
    // A separate explicit normal metadata operation enables the accepted tree.
    await invoke(["update", page, "--database", f.library.skills.database_id, "--enabled", "true"])
    expect(property(property(f.skills.get(page)).properties).enabled).toMatchObject({
      checkbox: true,
    })
    f.clear()
    const options = {
      database: f.library.skills.database_id,
      readOnly: true,
      metrics: true,
      env: {
        ...base,
        NOTION_API_TOKEN: "controlled-cold-current-tree-consumer",
        NTN_SKILLS_HOME: join(root, "consumer/state"),
        NTN_SKILLS_CONFIG_HOME: join(root, "consumer/config"),
        NTN_SKILLS_CACHE_HOME: join(root, "consumer/cache"),
        NTN_SKILLS_DATA_HOME: join(root, "consumer/data"),
      },
    }
    const main = await readSkill(page, { ...options, refresh: true })
    if (!("content" in main)) throw new Error("Ordinary cold SDK must return the complete main")
    const split = (value: string) => /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(value)!
    const inputMain = currentTreePortable().files[0]!
    expect(parseYaml(split(main.content)[1]!)).toEqual(
      parseYaml(split(new TextDecoder().decode(inputMain.bytes))[1]!),
    )
    expect(() =>
      assertImportedMarkdownContent(
        split(new TextDecoder().decode(inputMain.bytes))[2]!,
        split(main.content)[2]!,
      ),
    ).not.toThrow()
    const directory = new URL(main.ref)
    directory.pathname = "/"
    directory.searchParams.delete("file_id")
    const listing = await listSkill(directory.toString(), options)
    expect(listing.files.map((file) => file.path).sort()).toEqual(
      currentTreePortable()
        .files.map((file) => file.path)
        .sort(),
    )
    const resources = await readResources(
      {
        version: 1,
        refs: listing.files.filter((file) => file.path !== "SKILL.md").map((file) => file.ref),
        budget: { maxFiles: 3, maxBytes: 20000, timeBudgetMs: 30000 },
      },
      options,
    )
    expect(resources.status).toBe("ready")
    if (resources.status !== "ready") throw new Error(JSON.stringify(resources))
    expect(resources.selection.snapshot_id).toBe(main.snapshot_id)
    expect(resources.selection.version_id).toBe(main.version_id)
    for (const input of currentTreePortable().files.slice(1)) {
      const file = resources.files.find((item) => item.path === input.path)!
      expect(file.mode).toBe(input.mode)
      if (input.path.endsWith(".md"))
        expect(() =>
          assertImportedMarkdownContent(new TextDecoder().decode(input.bytes), file.content),
        ).not.toThrow()
      else {
        expect(file.content).toBe(new TextDecoder().decode(input.bytes))
        expect(file.sha256).toBe(createHash("sha256").update(input.bytes).digest("hex"))
      }
    }
    expect(f.writes()).toHaveLength(0)
    await writeFile(
      join(root, "proof.json"),
      JSON.stringify(
        {
          cli,
          sdk: sdkPath,
          originalFailure,
          page,
          complete_files: listing.files,
          full_frontmatter_verified: true,
          raw_bytes_and_modes_verified: true,
          independent_records: 6,
          original_status: "needs_review",
          normal_consumer_writes: 0,
          receipts,
        },
        null,
        2,
      ),
    )
  } finally {
    await writeFile(join(root, "invocations.json"), JSON.stringify(receipts, null, 2))
    server.closeAllConnections()
    server.close()
    console.info(JSON.stringify({ currentTreeEvidence: root }))
  }
}, 180000)
