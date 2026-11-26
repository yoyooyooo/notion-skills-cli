import { beforeAll, expect, test } from "bun:test"
import { Effect } from "effect"
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepareGraph } from "../../core/src/graph-prepare.ts"
import { Notion } from "../../core/src/notion.ts"
import { property } from "../../core/src/model.ts"
import {
  graphLibrary as library,
  nativeGraphFixture,
} from "../../core/test/graph-prepare-live-fixture.ts"
import { currentId as id } from "../../core/test/shared-current-fixture.ts"
import { trashPath } from "../../core/src/local-locks.ts"

const root = new URL("../../../", import.meta.url).pathname
const main = new URL("../dist/ntn-skills.js", import.meta.url).pathname
beforeAll(async () => {
  const build = Bun.spawn(["bun", "run", "build"], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
    build.exited,
  ])
  if (exit) throw new Error(stdout + stderr)
}, 120_000)

test("public Node use batches current HTTPS metadata, persists derived directories, and reports distinct readiness phases", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ntn-current-use-cli-"))
  const cert = join(directory, "cert.pem"),
    key = join(directory, "key.pem"),
    config = join(directory, "cert.cnf")
  await writeFile(
    config,
    "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n",
    { mode: 0o600 },
  )
  const certificate = Bun.spawn(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-config",
      config,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const certError = await new Response(certificate.stderr).text()
  expect(await certificate.exited, certError).toBe(0)
  const f = nativeGraphFixture({ filesPerSkill: 1 })
  await f.run(
    prepareGraph(
      { roots: [f.pageIds[0]!, f.pageIds[2]!], purpose: "use" },
      { library: library.library_id },
    ),
  )
  const calls: {
    method: string
    path: string
    body?: unknown
    request_bytes: number
    response_bytes: number
  }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { key: Bun.file(key), cert: Bun.file(cert) },
    async fetch(request) {
      const url = new URL(request.url),
        serialized = request.method === "GET" ? "" : await request.text()
      const body = serialized === "" ? undefined : JSON.parse(serialized)
      const path = url.pathname.slice(1) + url.search
      const method = request.method
      if (method !== "GET" && method !== "POST" && method !== "PATCH")
        return new Response("unsupported", { status: 400 })
      try {
        const result =
          path === "v1/users/me"
            ? { object: "user", id: id(99), type: "bot", bot: { workspace_id: id(100) } }
            : await f.run(Effect.flatMap(Notion, (api) => api.request(path, body, { method })))
        const response = JSON.stringify(result)
        calls.push({
          method,
          path,
          ...(body === undefined ? {} : { body }),
          request_bytes: Buffer.byteLength(serialized),
          response_bytes: Buffer.byteLength(response),
        })
        return new Response(response, { headers: { "Content-Type": "application/json" } })
      } catch (error) {
        return Response.json(
          { object: "error", status: 400, code: "validation_error", message: String(error) },
          { status: 400 },
        )
      }
    },
  })
  try {
    const poisonDir = join(directory, "poison"),
      poisonLog = join(directory, "ntn-called")
    await mkdir(poisonDir)
    await writeFile(
      join(poisonDir, "ntn"),
      "#!/bin/sh\nprintf called > '" + poisonLog + "'\nexit 91\n",
      { mode: 0o755 },
    )
    const invoke = async (condition: string, extra: readonly string[] = []) => {
      const offset = calls.length
      const child = Bun.spawn(
        [
          Bun.which("node")!,
          main,
          "use",
          f.pageIds[0]!,
          "--library",
          library.library_id,
          "--json",
          "--metrics",
          ...extra,
        ],
        {
          cwd: directory,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            PATH: poisonDir + ":" + process.env.PATH,
            NODE_EXTRA_CA_CERTS: cert,
            NOTION_API_TOKEN: "controlled-current-use-token",
            NOTION_API_BASE_URL: server.url.origin,
            NOTION_WORKSPACE_ID: "",
            NTN_SKILLS_REQUEST_TRACE_LIMIT: condition === "cold" ? "0" : "128",
            NTN_SKILLS_HOME: join(directory, "state"),
            NTN_SKILLS_CONFIG_HOME: join(directory, "config"),
            NTN_SKILLS_CACHE_HOME: join(directory, "cache"),
          },
        },
      )
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(exit, stderr + stdout).toBe(0)
      const consumed = JSON.parse(stdout)
      expect(consumed.status).toBe("ready")
      expect(consumed.effects.remote_writes).toBe("none")
      const result = { ...consumed.preparation, request_metrics: consumed.request_metrics },
        actual = calls.slice(offset)
      expect(result.status).toBe("ready")
      expect(result.usage.prepared_nodes).toBe(4)
      expect(result.request_metrics.total_requests).toBe(actual.length)
      expect(result.request_metrics.request_bytes).toBe(
        actual.reduce((sum, call) => sum + call.request_bytes, 0),
      )
      expect(result.request_metrics.response_bytes).toBe(
        actual.reduce((sum, call) => sum + call.response_bytes, 0),
      )
      expect(result.request_metrics.requests.notion_write).toBe(0)
      expect(result.request_metrics.requests.provider).toBe(0)
      expect(result.request_metrics.retry_wait_ms).toBe(0)
      expect(result.request_metrics.coalesced_requests).toBe(0)
      expect(result.request_metrics.trace_enabled).toBe(condition !== "cold")
      expect(result.request_metrics.trace_dropped).toBe(0)
      expect(result.preparation_metrics.root_ready_ms).toBeLessThanOrEqual(
        result.preparation_metrics.required_ready_ms,
      )
      expect(result.preparation_metrics.required_ready_ms).toBeLessThanOrEqual(
        result.preparation_metrics.elapsed_ms,
      )
      expect(
        actual.filter(
          (call) => call.method !== "GET" && !call.path.split("?", 1)[0]!.endsWith("/query"),
        ),
      ).toEqual([])
      expect(actual.some((call) => call.path.startsWith(`v1/pages/${f.pageIds[4]}/markdown`))).toBe(
        false,
      )
      const metadata = actual.filter(
        (call) =>
          call.path.split("?", 1)[0] === `v1/data_sources/${library.skills.data_source_id}/query`,
      )
      expect(metadata).toHaveLength(condition === "warm" ? 0 : 4)
      expect(
        metadata.map((call) => {
          const filter = property(property(call.body).filter)
          const parts = Array.isArray(filter.or) ? filter.or : [filter]
          return parts.map((raw) => {
            expect(property(raw).property).toBe(library.skills.property_ids["Skill ID"])
            return property(property(raw).rich_text).equals
          })
        }),
      ).toEqual(condition === "warm" ? [] : [["a"], ["optional"], ["b", "c"], ["d"]])
      return { result, actual }
    }
    const cold = await invoke("cold")
    expect(cold.result.preparation_metrics.derived_cache_misses).toBe(4)
    // Two batched reads discover Files; each of the four owners then checks its final fence.
    expect(
      cold.actual.filter(
        (call) =>
          call.path.split("?", 1)[0] === `v1/data_sources/${library.files.data_source_id}/query`,
      ),
    ).toHaveLength(6)
    const warm = await invoke("warm")
    expect(warm.result.graph_lock).toEqual(cold.result.graph_lock)
    expect(warm.result.preparation_metrics.derived_cache_hits).toBe(4)
    expect(warm.actual.map((call) => call.path)).toEqual(["v1/users/me"])
    await Bun.sleep(1_100)
    const revalidated = await invoke("metadata_revalidate", ["--max-age", "1s"])
    expect(revalidated.result.graph_lock).toEqual(cold.result.graph_lock)
    expect(revalidated.result.preparation_metrics.derived_cache_hits).toBe(4)
    expect(
      revalidated.actual.filter((call) => call.path.split("?", 1)[0]!.endsWith("/markdown")),
    ).toEqual([])
    await expect(access(poisonLog)).rejects.toBeDefined()
  } finally {
    server.stop(true)
    if (process.platform === "darwin") await Effect.runPromise(trashPath(directory))
  }
}, 120_000)
