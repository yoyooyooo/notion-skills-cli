import { expect, test, beforeAll } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Notion } from "../../core/src/notion.ts"
import { property } from "../../core/src/model.ts"
import {
  sourceRefreshFixture,
  library,
  definition,
  relatedSkill,
  relation,
} from "../../core/test/shared-source-refresh-fixture.ts"
import { digest, encode, id, rich, skillPage } from "../../core/test/shared-snapshot-fixture.ts"

const root = new URL("../../../", import.meta.url).pathname
const main = new URL("../dist/ntn-skills.js", import.meta.url).pathname
beforeAll(async () => {
  const child = Bun.spawn(["bun", "run", "build"], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code) throw new Error(stdout + stderr)
}, 120_000)

test("public source prepare/apply uses real HTTP with controlled A/B/C resources and only approved PATCH keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ng07-source-cli-"))
  const keyPath = join(directory, "test-key.pem"),
    certPath = join(directory, "test-cert.pem"),
    configPath = join(directory, "test-cert.cnf")
  await writeFile(
    configPath,
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
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-config",
      configPath,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const certificateError = await new Response(certificate.stderr).text()
  expect(await certificate.exited, certificateError).toBe(0)
  let version = "a"
  let f: Awaited<ReturnType<typeof sourceRefreshFixture>> | undefined
  const calls: { method: string; path: string; body?: unknown }[] = []
  const tree = (revision: string) => [
    {
      path: "SKILL.md",
      bytes: encode(
        "---\nname: Upstream\ndescription: Candidate\nlicense: MIT\n---\n\nUpstream " +
          revision +
          "\n",
      ),
    },
    { path: "references/1.md", bytes: encode("Provider resource " + revision + "\n") },
    { path: "assets/data.bin", bytes: new Uint8Array([0, 255, revision.charCodeAt(0)]) },
  ]
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { key: Bun.file(keyPath), cert: Bun.file(certPath) },
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/v1/users/me")
        return Response.json({
          object: "user",
          id: id(99),
          type: "bot",
          bot: { workspace_id: id(100) },
        })
      if (url.pathname === "/api/v1/skills/demo")
        return Response.json({
          skill: { slug: "demo" },
          owner: { handle: "controlled" },
          latestVersion: { version },
        })
      const match = /^\/api\/v1\/skills\/demo\/versions\/([^/]+)$/.exec(url.pathname)
      if (match)
        return Response.json({
          version: {
            version: match[1],
            files: tree(match[1]!).map((file) => ({
              path: file.path,
              size: file.bytes.length,
              sha256: digest(file.bytes),
            })),
          },
        })
      if (url.pathname === "/api/v1/skills/demo/file") {
        const file = tree(url.searchParams.get("version")!).find(
          (item) => item.path === url.searchParams.get("path"),
        )
        return file ? new Response(file.bytes) : new Response("missing", { status: 404 })
      }
      const body = request.method === "GET" ? undefined : await request.json()
      const path = url.pathname.slice(1) + url.search
      calls.push({ method: request.method, path, ...(body === undefined ? {} : { body }) })
      try {
        const result = await f!.run(
          Effect.flatMap(Notion, (api) =>
            api.request(path, body, { method: request.method as "GET" | "POST" | "PATCH" }),
          ),
        )
        return Response.json(result)
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
    f = await sourceRefreshFixture({
      member: ".",
      definition: {
        ...definition,
        adapter: {
          type: "registry",
          base_url: server.url.origin,
          owner: "controlled",
          slug: "demo",
        },
        selection: { roots: ["."], include: [], exclude: [], mapping: {} },
      },
    })
    relatedSkill(f, id(91), "keep", "Keep")
    relatedSkill(f, id(92), "remove", "Remove")
    relatedSkill(f, id(93), "add", "Added manually")
    relatedSkill(f, id(94), "required", "Required manually")
    const p = property(f.main.properties)
    p.members = relation("members", [id(91), id(92)])
    p.requires = relation("requires", [])
    p.tags = { id: "tags", type: "multi_select", multi_select: [{ name: "author-tag" }] }
    p["extra-field"] = rich("extra-field", "preserve")
    const poisonDir = join(directory, "poison"),
      poisonLog = join(directory, "ntn-called")
    await mkdir(poisonDir)
    await writeFile(
      join(poisonDir, "ntn"),
      "#!/bin/sh\nprintf called > '" + poisonLog + "'\nexit 91\n",
      { mode: 0o755 },
    )
    const invoke = async (...args: string[]) => {
      const child = Bun.spawn([Bun.which("node")!, main, ...args], {
        cwd: directory,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PATH: poisonDir + ":" + process.env.PATH,
          NODE_EXTRA_CA_CERTS: certPath,
          NOTION_API_TOKEN: "controlled-ng07-token",
          NOTION_API_BASE_URL: server.url.origin,
          NTN_SKILLS_CONFIG_HOME: join(directory, "config"),
          NTN_SKILLS_HOME: join(directory, "state"),
          NTN_SKILLS_CACHE_HOME: join(directory, "cache"),
          NTN_SKILLS_DATA_HOME: join(directory, "data"),
        },
      })
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(exit, stderr + stdout).toBe(0)
      return JSON.parse(stdout)
    }
    const outcomes: unknown[] = []
    let protectedProps: Record<string, unknown> = {}
    const bodies = new Map(f.bodies)
    for (const revision of ["a", "b", "c"]) {
      version = revision
      if (revision === "b") {
        p.members = relation("members", [id(91), id(93)])
        p.requires = relation("requires", [id(94)])
        protectedProps = structuredClone(
          Object.fromEntries(Object.entries(p).filter(([key]) => key !== "source")),
        )
      }
      const planPath = join(directory, "refresh-" + revision + ".json")
      const prepared = await invoke(
        "ctl",
        "library",
        "sources",
        "prepare",
        id(82),
        "--entry",
        library.skills.database_id,
        "--target",
        skillPage,
        "--output",
        planPath,
      )
      const frozen = JSON.parse(await readFile(planPath, "utf8"))
      expect(frozen.version).toBe(3)
      expect(prepared.member_review.relation_writes).toBe(false)
      const start = calls.length
      const dryRun = await invoke(
        "ctl",
        "library",
        "sources",
        "apply",
        planPath,
        "--entry",
        library.skills.database_id,
        "--dry-run",
      )
      expect(dryRun.notion_writes).toBe(0)
      expect(
        calls.slice(start).some((call) => call.method === "PATCH" || call.path === "v1/pages"),
      ).toBe(false)
      const applyStart = calls.length
      const applied = await invoke(
        "ctl",
        "library",
        "sources",
        "apply",
        planPath,
        "--entry",
        library.skills.database_id,
      )
      expect(applied.verified).toBe(true)
      const patches = calls
        .slice(applyStart)
        .filter((call) => call.method === "PATCH")
        .map((call) => ({
          path: call.path,
          property_ids: Object.keys(property(property(call.body).properties)).sort(),
        }))
      expect(patches.filter((call) => call.path === "v1/pages/" + skillPage)).toEqual([
        { path: "v1/pages/" + skillPage, property_ids: ["source"] },
      ])
      if (revision !== "a")
        expect(Object.fromEntries(Object.entries(p).filter(([key]) => key !== "source"))).toEqual(
          protectedProps,
        )
      expect(f.bodies).toEqual(bodies)
      outcomes.push({
        revision,
        prepared,
        applied,
        patches,
        property_id_to_value: structuredClone(p),
      })
    }
    await expect(access(poisonLog)).rejects.toThrow()
    const evidenceDir = process.env.NTN_NG07_EVIDENCE_DIR
    if (evidenceDir) {
      await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
      await writeFile(
        join(evidenceDir, "public-cli-http.json"),
        JSON.stringify(
          {
            kind: "controlled_http_public_cli",
            real_notion: false,
            real_registry: false,
            cli_sha256: digest(await readFile(main)),
            node: Bun.which("node"),
            ntn_calls: 0,
            command_artifacts: directory,
            outcomes,
          },
          null,
          2,
        ) + "\n",
        { mode: 0o600 },
      )
    }
  } finally {
    server.stop(true)
  }
}, 120_000)
