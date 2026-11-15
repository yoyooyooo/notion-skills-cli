import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import { discoverSource } from "../src/upstream-source.ts"
import { createRequestMetrics } from "../src/request-metrics.ts"

test("selected Git blobs share one fetch without downloading unselected objects or executing resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntn-source-batch-"))
  const work = join(root, "author"),
    bare = join(root, "source.git")
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Source Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.test",
    GIT_COMMITTER_NAME: "Source Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.test",
  }
  const git = (cwd: string, args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { env, encoding: "utf8" }).trim()
  const requests: string[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks)
    requests.push(body.toString("utf8"))
    const url = new URL(request.url!, "http://127.0.0.1")
    const child = Bun.spawn(["git", "http-backend"], {
      env: {
        ...env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method!,
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        CONTENT_LENGTH: String(body.length),
        HTTP_GIT_PROTOCOL: String(request.headers["git-protocol"] ?? ""),
        SERVER_PROTOCOL: "HTTP/1.1",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    child.stdin.write(body)
    child.stdin.end()
    const [bytes, error, exit] = await Promise.all([
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const raw = Buffer.from(bytes),
      boundary = raw.indexOf("\r\n\r\n")
    if (exit !== 0 || boundary < 0) {
      response.writeHead(500)
      response.end(error)
      return
    }
    const headers: Record<string, string> = {}
    let status = 200
    for (const line of raw.subarray(0, boundary).toString("utf8").split("\r\n")) {
      const at = line.indexOf(":"),
        name = line.slice(0, at).toLowerCase(),
        value = line.slice(at + 1).trim()
      if (name === "status") status = Number(value.split(" ")[0])
      else headers[name] = value
    }
    response.writeHead(status, headers)
    response.end(raw.subarray(boundary + 4))
  })
  try {
    await mkdir(join(work, "skills/small"), { recursive: true })
    git(work, ["init", "-b", "main"])
    const files = new Map<string, Uint8Array>([
      [
        "SKILL.md",
        new TextEncoder().encode(
          "---\nname: batch-small\ndescription: Exact source batching fixture\n---\n\nRead the selected bytes.\n",
        ),
      ],
    ])
    for (let i = 0; i < 12; i++)
      files.set(
        `resource-${i}.txt`,
        new TextEncoder().encode(`Resource ${i}: unchanged exact bytes.\n`),
      )
    for (const [path, bytes] of files) await writeFile(join(work, "skills/small", path), bytes)
    await mkdir(join(work, "unselected"))
    await writeFile(join(work, "unselected/large.bin"), randomBytes(2 * 1024 * 1024))
    git(work, ["add", "."])
    git(work, ["commit", "--no-gpg-sign", "-m", "exact source fixture"])
    const revision = git(work, ["rev-parse", "HEAD"])
    git(root, ["clone", "--bare", work, bare])
    git(bare, ["config", "uploadpack.allowFilter", "true"])
    git(bare, ["config", "uploadpack.allowAnySHA1InWant", "true"])
    const selectedOids = [...files.keys()].map((path) =>
      git(work, ["rev-parse", `${revision}:skills/small/${path}`]),
    )
    const unselected = git(work, ["rev-parse", `${revision}:unselected/large.bin`])
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as { port: number }).port,
      metrics = createRequestMetrics()
    const snapshot = await Effect.runPromise(
      discoverSource(
        {
          source: { type: "git", url: `http://127.0.0.1:${port}/source.git`, ref: revision },
          roots: ["skills/small"],
          include: [],
          exclude: [],
          mapping: {},
        },
        { metrics },
      ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerFetch))),
    )
    const blobRequests = requests
      .map((body) => selectedOids.filter((oid) => body.includes(`want ${oid}`)))
      .filter((wants) => wants.length > 0)
    const evidence = {
      revision,
      selected_files: files.size,
      blob_fetch_requests: blobRequests.length,
      wants: blobRequests,
      unselected_requested: requests.some((body) => body.includes(`want ${unselected}`)),
      metrics: metrics.snapshot().source_acquisitions,
    }
    if (process.env.NTN_SOURCE_BATCH_EVIDENCE)
      await writeFile(process.env.NTN_SOURCE_BATCH_EVIDENCE, JSON.stringify(evidence, null, 2))
    expect(snapshot.members).toHaveLength(1)
    for (const [path, bytes] of files)
      expect(snapshot.members[0]!.portable.files.find((file) => file.path === path)?.bytes).toEqual(
        bytes,
      )
    expect(evidence.unselected_requested).toBe(false)
    expect(evidence.metrics?.repository_object_bytes).toBeLessThan(256 * 1024)
    expect(blobRequests).toHaveLength(1)
    expect(new Set(blobRequests[0])).toEqual(new Set(selectedOids))
    expect(await readFile(join(work, "skills/small/SKILL.md"))).toEqual(
      Buffer.from(files.get("SKILL.md")!),
    )
  } finally {
    server.closeAllConnections()
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
