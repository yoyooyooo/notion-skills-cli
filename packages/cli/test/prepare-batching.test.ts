import { beforeAll, expect, test } from "bun:test"
import { Effect } from "effect"
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepareGraph } from "../../core/src/graph-prepare.ts"
import { Notion } from "../../core/src/notion.ts"
import { nativeGraphFixture } from "../../core/test/graph-prepare-live-fixture.ts"
import { digest, id, library } from "../../core/test/shared-snapshot-fixture.ts"

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

test("public Node prepare batches real HTTPS metadata, persists derived directories, and reports distinct readiness phases", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ng16-prepare-cli-"))
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
      { database: library.skills.database_id },
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
    const reports: unknown[] = []
    let processCount = 0
    const invoke = async (condition: string, extra: readonly string[] = []) => {
      const start = performance.now(),
        offset = calls.length
      const child = Bun.spawn(
        [
          Bun.which("node")!,
          main,
          "prepare",
          f.pageIds[0]!,
          f.pageIds[2]!,
          "--database",
          library.skills.database_id,
          "--purpose",
          "use",
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
            NOTION_API_TOKEN: "controlled-ng16-token",
            NOTION_API_BASE_URL: server.url.origin,
            NOTION_WORKSPACE_ID: "",
            NTN_SKILLS_REQUEST_TRACE_LIMIT: condition === "cold" ? "0" : "128",
            NTN_SKILLS_HOME: join(directory, "state"),
            NTN_SKILLS_CONFIG_HOME: join(directory, "config"),
            NTN_SKILLS_CACHE_HOME: join(directory, "cache"),
            NTN_SKILLS_DATA_HOME: join(directory, "data"),
          },
        },
      )
      processCount++
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(exit, stderr + stdout).toBe(0)
      const result = JSON.parse(stdout),
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
      expect(metadata.length).toBeLessThanOrEqual(1)
      reports.push({
        condition,
        process_count: 1,
        elapsed_with_process_ms: performance.now() - start,
        result,
        actual_http: actual,
      })
      return { result, actual }
    }
    const cold = await invoke("cold")
    expect(cold.result.preparation_metrics.derived_cache_misses).toBe(4)
    expect(
      cold.actual.filter(
        (call) =>
          call.path.split("?", 1)[0] === `v1/data_sources/${library.files.data_source_id}/query`,
      ),
    ).toHaveLength(2)
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
    const evidence = {
      version: 1,
      evidence_kind: "public_node_cli_https_controlled",
      cli_sha256: digest(await readFile(main)),
      process_count: processCount,
      writes: 0,
      source_body_requests: 0,
      official_ntn_invocations: 0,
      percentile_claim: null,
      reports,
    }
    await writeFile(join(directory, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n")
    if (process.env.NTN_NG16_EVIDENCE_DIR) {
      await mkdir(process.env.NTN_NG16_EVIDENCE_DIR, { recursive: true })
      await writeFile(
        join(process.env.NTN_NG16_EVIDENCE_DIR, "public-cli-evidence.json"),
        JSON.stringify({ ...evidence, original: directory }, null, 2) + "\n",
      )
    }
  } finally {
    server.stop(true)
  }
}, 120_000)
