import { beforeAll, expect, test } from "bun:test"
import { Effect } from "effect"
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Notion } from "../../core/src/notion.ts"
import { fileRef } from "../../core/src/ref.ts"
import {
  digest,
  id,
  library,
  sharedSnapshotFixture,
  skillPage,
} from "../../core/test/shared-snapshot-fixture.ts"

const root = new URL("../../../", import.meta.url).pathname
const main = new URL("../dist/ntn-skills.js", import.meta.url).pathname
beforeAll(async () => {
  const child = Bun.spawn(["bun", "run", "build"], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exit) throw new Error(stdout + stderr)
}, 120_000)

test("public graph commands retain A and cold independent Node state lazily reads exact history after current becomes B", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ng17-graph-cli-"))
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
  const certificateError = await new Response(certificate.stderr).text()
  expect(await certificate.exited, certificateError).toBe(0)
  const f = sharedSnapshotFixture({ fileCount: 3 })
  const resource = "Exact historical resource A\r\n".repeat(1400)
  const first = f.files[0],
    second = f.files[1]
  if (first === undefined || second === undefined) throw new Error("Missing resource fixture")
  f.bodies.set(skillPage, "# Native historical A\n")
  f.bodies.set(first.id, "Oversized current native observation\n".repeat(3000))
  f.bodies.set(second.id, "Other resource A\n")
  const calls: { method: string; path: string; body?: unknown }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { key: Bun.file(key), cert: Bun.file(cert) },
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/v1/users/me")
        return Response.json({
          object: "user",
          id: id(99),
          type: "bot",
          bot: { workspace_id: id(100) },
        })
      const body = request.method === "GET" ? undefined : await request.json()
      const path = url.pathname.slice(1) + url.search
      calls.push({ method: request.method, path, ...(body === undefined ? {} : { body }) })
      try {
        const method = request.method
        if (method !== "GET" && method !== "POST" && method !== "PATCH")
          throw new Error("Unsupported controlled method")
        return Response.json(
          await f.run(Effect.flatMap(Notion, (api) => api.request(path, body, { method }))),
        )
      } catch (error) {
        return Response.json(
          {
            object: "error",
            status: 400,
            code: "validation_error",
            message: error instanceof Error ? error.message : String(error),
          },
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
    const run = async (machine: "a" | "b", args: readonly string[], expectedExit = 0) => {
      const base = join(directory, machine)
      const child = Bun.spawn([Bun.which("node")!, main, ...args], {
        cwd: directory,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PATH: poisonDir + ":" + process.env.PATH,
          NODE_EXTRA_CA_CERTS: cert,
          NOTION_API_TOKEN: "controlled-ng17-token",
          NOTION_API_BASE_URL: server.url.origin,
          NTN_SKILLS_HOME: base + "-state",
          NTN_SKILLS_CONFIG_HOME: base + "-config",
          NTN_SKILLS_CACHE_HOME: base + "-cache",
          NTN_SKILLS_DATA_HOME: base + "-data",
        },
      })
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(exit, stderr + stdout).toBe(expectedExit)
      return JSON.parse(stdout)
    }
    const invoke = (machine: "a" | "b", ...args: string[]) => run(machine, args)
    const incomplete = await run(
      "a",
      [
        "prepare",
        skillPage,
        "--database",
        library.skills.database_id,
        "--purpose",
        "use",
        "--metrics",
      ],
      1,
    )
    expect(incomplete.error.code).toBe("SHARED_RECORD_TOO_LARGE")
    expect(incomplete.error.details.preparation.graph_lock).toBeUndefined()
    f.bodies.set(first.id, resource)
    const prepared = await invoke(
      "a",
      "prepare",
      skillPage,
      "--database",
      library.skills.database_id,
      "--purpose",
      "use",
      "--metrics",
    )
    const preparedPath = join(directory, "prepared.json")
    await writeFile(preparedPath, JSON.stringify(prepared))
    const planned = await invoke(
      "a",
      "ctl",
      "library",
      "graph",
      "plan",
      "--input",
      preparedPath,
      "--entry",
      library.skills.database_id,
    )
    const planPath = join(directory, "plan.json")
    await writeFile(planPath, JSON.stringify(planned))
    const saved = await invoke(
      "a",
      "ctl",
      "library",
      "graph",
      "save",
      "--input",
      planPath,
      "--entry",
      library.skills.database_id,
    )
    expect(saved.verification).toBe("objects_and_manifest")
    f.bodies.set(skillPage, "# Current B must never replace historical A\n")
    f.bodies.set(first.id, "Current resource B\n")
    f.bodies.set(second.id, "Current other resource B\n")
    const start = calls.length
    const restored = await invoke(
      "b",
      "ctl",
      "library",
      "graph",
      "restore",
      saved.graph_id,
      "--entry",
      library.skills.database_id,
      "--materialize",
      "manifest",
    )
    expect(restored).toMatchObject({
      manifest_complete: true,
      local_files_ready: false,
      loaded: false,
      materialization: "manifest",
    })
    expect(restored.graph_lock).toEqual(prepared.graph_lock)
    expect(calls.slice(start).some((call) => call.path.includes("/markdown"))).toBe(false)
    expect(
      calls.slice(start).some((call) => JSON.stringify(call.body)?.includes('"equals":"object"')),
    ).toBe(false)
    const node = restored.nodes[0]
    const listed = await invoke("b", "files", fileRef(node.record.id, "", node.snapshot_id))
    expect(listed.files).toHaveLength(3)
    expect(listed.materialization.local_files_ready).toBe(false)
    const beforeMain = calls.length
    const mainRead = await invoke("b", "read", node.ref)
    expect(mainRead.content).toContain("Native historical A")
    expect(mainRead.materialization).toMatchObject({
      manifest_complete: true,
      local_files_ready: false,
      loaded: false,
      materialized_paths: [node.entrypoint],
    })
    const mainQueries = calls
      .slice(beforeMain)
      .filter((call) => JSON.stringify(call.body)?.includes('"equals":"object"'))
    expect(mainQueries).toHaveLength(1)
    const historical = planned.plan.nodes[0].history.manifest
    const resourceFile = historical.files.find(
      (file: { path: string }) => file.path === "references/1.md",
    )
    const secondFile = historical.files.find(
      (file: { path: string }) => file.path === "references/2.md",
    )
    if (resourceFile === undefined || secondFile === undefined)
      throw new Error("Missing full manifest resources")
    expect(resourceFile.chunks.length).toBeGreaterThan(1)
    for (const file of [resourceFile, secondFile])
      for (const chunk of file.chunks)
        expect(JSON.stringify(mainQueries)).not.toContain(chunk.object_id)
    const beforeResource = calls.length
    const output = join(directory, "downloaded-resource.md")
    await invoke(
      "b",
      "read",
      fileRef(node.record.id, "references/1.md", node.snapshot_id),
      "--output",
      output,
    )
    expect(await readFile(output, "utf8")).toBe(resource.replaceAll("\r\n", "\n"))
    expect(digest(new Uint8Array(await readFile(output)))).toBe(resourceFile.sha256)
    const resourceQueries = calls
      .slice(beforeResource)
      .filter((call) => JSON.stringify(call.body)?.includes('"equals":"object"'))
    expect(resourceQueries).toHaveLength(1)
    for (const chunk of resourceFile.chunks)
      expect(JSON.stringify(resourceQueries)).toContain(chunk.object_id)
    for (const chunk of secondFile.chunks)
      expect(JSON.stringify(resourceQueries)).not.toContain(chunk.object_id)
    const exportedPath = join(directory, "complete-export")
    const exported = await invoke(
      "b",
      "export",
      node.ref,
      "--projection",
      "snapshot",
      "--output",
      exportedPath,
    )
    expect(exported.materialization.local_files_ready).toBe(true)
    for (const file of historical.files)
      expect(digest(new Uint8Array(await readFile(join(exportedPath, file.path))))).toBe(
        file.sha256,
      )
    const repeated = await invoke(
      "b",
      "ctl",
      "library",
      "graph",
      "save",
      "--input",
      planPath,
      "--entry",
      library.skills.database_id,
      "--reconcile",
    )
    expect(repeated).toMatchObject({ verification: "manifest", mode: "reconcile" })
    expect(
      calls.slice(start).filter((call) => call.method !== "GET" && !call.path.includes("/query")),
    ).toEqual([])
    expect(calls.slice(start).some((call) => call.path.includes("/markdown"))).toBe(false)
    expect(
      await access(poisonLog).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
    await writeFile(
      join(directory, "evidence.json"),
      JSON.stringify(
        {
          graph_id: saved.graph_id,
          source_snapshot: prepared.graph_lock.bindings[0].snapshot_id,
          restored_snapshot: node.snapshot_id,
          initial_incomplete: incomplete,
          restoration: restored,
          calls: calls.slice(start),
          hashes: historical.files.map((file: { path: string; sha256: string }) => ({
            path: file.path,
            sha256: file.sha256,
          })),
          official_ntn_calls: 0,
        },
        null,
        2,
      ),
    )
  } finally {
    server.stop(true)
  }
}, 120_000)
