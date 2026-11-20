import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { ConfigProvider, Effect, Schema, Redacted } from "effect"
import {
  HttpClient,
  HttpClientResponse,
  HttpClientError,
  type HttpClientRequest,
} from "effect/http"
import { fail, property, SkillsError } from "../src/model.ts"
import { createRequestMetrics } from "../src/request-metrics.ts"
import type { FixedGithubFile, FixedGithubSource } from "../src/shared-github-source.ts"
import { materializeFixedGithubSource } from "../src/shared-source-materialization.ts"
import { Store } from "../src/store.ts"
import { FixedGitObjectReader } from "../src/shared-fixed-git-transport.ts"
import { GhCredential } from "../src/github-api-access.ts"

const encode = (value: string) => new TextEncoder().encode(value)
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const blobId = (bytes: Uint8Array) =>
  createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex")
const root = "skills/demo"
const entry = (path: string, bytes: Uint8Array): FixedGithubFile => ({
  path,
  source_path: `${root}/${path}`,
  git_oid: blobId(bytes),
  bytes: bytes.byteLength,
})
const makeSource = (files: readonly FixedGithubFile[]): FixedGithubSource => ({
  url: "https://github.com/example/skills",
  commit: "1".repeat(40),
  tree: "2".repeat(40),
  root,
  files,
})
const key = (oid: string) => `cache/shared-github-blobs/${oid}.json`

function fixture(
  bodyByPath: ReadonlyMap<string, Uint8Array>,
  delay = false,
  transport?: {
    mode: "auto" | "http" | "git"
    reader?: FixedGitObjectReader["Service"]
    networkFailure?: boolean
    response?: (request: HttpClientRequest.HttpClientRequest, url: URL) => Response
  },
) {
  const json = new Map<string, unknown>()
  const objects = new Map<string, Uint8Array>()
  const writes: string[] = []
  const objectReads: string[] = []
  const cacheReads: string[] = []
  const requests: string[] = []
  let active = 0
  let peak = 0
  const unexpected = () => Effect.die(new Error("Unexpected Store operation."))
  const store: Store["Service"] = {
    root: "/controlled",
    configRoot: "/controlled/config",
    cacheRoot: "/controlled/cache",
    reserveCacheGeneration: unexpected,
    listKeys: unexpected,
    retireKeys: unexpected,
    backup: unexpected,
    output: unexpected,
    readJson: (key, schema) =>
      Effect.try({
        try: () => {
          cacheReads.push(key)
          const value = json.get(key)
          return value === undefined ? undefined : Schema.decodeUnknownSync(schema)(value)
        },
        catch: () => fail("STATE_CORRUPT", "Controlled invalid cache entry."),
      }),
    writeJson: (key, value) =>
      Effect.sync(() => {
        writes.push(key)
        json.set(key, structuredClone(value))
      }),
    readBytes: (key) =>
      Effect.try({
        try: () => {
          objectReads.push(key)
          const value = objects.get(key)
          if (value === undefined) throw fail("SNAPSHOT_MISSING", "Controlled missing object.")
          return value.slice()
        },
        catch: (error) =>
          error instanceof SkillsError
            ? error
            : fail("STORAGE_ERROR", "Controlled object read failed."),
      }),
    writeBytes: (key, bytes) =>
      Effect.try({
        try: () => {
          const previous = objects.get(key)
          if (
            previous !== undefined &&
            (previous.length !== bytes.length ||
              previous.some((byte, index) => byte !== bytes[index]))
          ) {
            throw fail("STATE_CORRUPT", "An immutable object cannot be replaced.")
          }
          writes.push(key)
          objects.set(key, bytes.slice())
        },
        catch: (error) =>
          error instanceof SkillsError
            ? error
            : fail("STORAGE_ERROR", "Controlled object write failed."),
      }),
  }
  const client = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      requests.push(url.toString())
      if (transport?.networkFailure)
        return yield* Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: new Error("Controlled exact raw transport unavailable"),
            }),
          }),
        )
      active += 1
      peak = Math.max(peak, active)
      return yield* Effect.gen(function* () {
        if (delay) yield* Effect.sleep("5 millis")
        if (transport?.response)
          return HttpClientResponse.fromWeb(request, transport.response(request, url))
        const sourcePath = decodeURIComponent(url.pathname.split("/").slice(4).join("/"))
        const bytes = bodyByPath.get(sourcePath)
        if (bytes === undefined)
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 404 }))
        return HttpClientResponse.fromWeb(
          request,
          new Response(bytes.slice(), { headers: { "content-length": String(bytes.length) } }),
        )
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            active -= 1
          }),
        ),
      )
    }),
  )
  const metrics = createRequestMetrics()
  const operation = (source: FixedGithubSource, paths?: readonly string[]) => {
    let action = materializeFixedGithubSource(source, { metrics }, paths)
    if (transport?.reader)
      action = action.pipe(Effect.provideService(FixedGitObjectReader, transport.reader))
    return transport === undefined
      ? action
      : action.pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({ NTN_SKILLS_FIXED_GIT_TRANSPORT: transport.mode }),
            ),
          ),
        )
  }
  const materialize = (source: FixedGithubSource, paths?: readonly string[]) =>
    Effect.runPromise(
      operation(source, paths).pipe(
        Effect.provideService(Store, store),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provide(NodeServices.layer),
      ),
    )
  const rejected = (source: FixedGithubSource, paths?: readonly string[]) =>
    Effect.runPromise(
      Effect.flip(operation(source, paths)).pipe(
        Effect.provideService(Store, store),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provide(NodeServices.layer),
      ),
    )
  const configured = (
    source: FixedGithubSource,
    env: Record<string, string>,
    gh?: GhCredential["Service"],
  ) => {
    let program = materializeFixedGithubSource(source, { metrics }).pipe(Effect.result)
    if (gh !== undefined) program = program.pipe(Effect.provideService(GhCredential, gh))
    if (transport?.reader !== undefined)
      program = program.pipe(Effect.provideService(FixedGitObjectReader, transport.reader))
    return Effect.runPromise(
      program.pipe(
        Effect.provideService(Store, store),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provide(NodeServices.layer),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
      ),
    )
  }
  return {
    json,
    objects,
    writes,
    objectReads,
    cacheReads,
    requests,
    metrics,
    materialize,
    rejected,
    configured,
    peak: () => peak,
  }
}

test("concurrent API identities do not coalesce across complete configuration scopes on the same Store/client", async () => {
  const bytes = encode("shared exact source"),
    file = entry("only.txt", bytes),
    source = makeSource([file])
  const tokens: string[] = [],
    f = fixture(new Map(), true, {
      mode: "http",
      response: (request) => {
        const token = request.headers.authorization ?? ""
        tokens.push(token)
        return token === "Bearer allowed-session"
          ? new Response(bytes)
          : new Response(null, { status: 403, headers: { "x-ratelimit-remaining": "20" } })
      },
    })
  const [allowed, denied] = await Promise.all([
    f.configured(source, { GH_TOKEN: "allowed-session" }),
    f.configured(source, { GH_TOKEN: "denied-session" }),
  ])
  expect(allowed._tag).toBe("Success")
  expect(denied._tag).toBe("Failure")
  if (denied._tag === "Success") throw new Error("Expected independent access failure")
  expect(denied.failure.code).toBe("GITHUB_ACCESS_FORBIDDEN")
  expect(tokens.sort()).toEqual(["Bearer allowed-session", "Bearer denied-session"])
})

test("custom API wins auto batch selection and warm reads neither query gh nor transfer Git objects", async () => {
  const bodies = Array.from({ length: 6 }, (_, index) => encode("original-" + index)),
    files = bodies.map((bytes, index) => entry("file-" + index + ".bin", bytes)),
    source = makeSource(files)
  let ghCalls = 0,
    gitCalls = 0
  const f = fixture(new Map(), false, {
    mode: "auto",
    reader: {
      read: () => {
        gitCalls++
        return Effect.die("Custom API must not choose Git")
      },
    },
    response: (request, url) => {
      expect(request.headers.authorization).toBeUndefined()
      const file = files.find((file) => url.pathname.endsWith("/" + file.git_oid))!
      const bytes = bodies[files.indexOf(file)]!
      return Response.json({
        sha: file.git_oid,
        size: bytes.length,
        encoding: "base64",
        content: Buffer.from(bytes).toString("base64"),
      })
    },
  })
  const gh = {
    resolve: Effect.sync(() => {
      ghCalls++
      return Redacted.make("never-send-official-session")
    }),
  }
  const env = {
    NTN_SKILLS_GITHUB_API_URL: "https://gateway.example.test/api",
    GH_TOKEN: "not-for-gateway",
  }
  expect((await f.configured(source, env, gh))._tag).toBe("Success")
  expect(f.requests).toHaveLength(6)
  expect(ghCalls).toBe(0)
  expect(gitCalls).toBe(0)
  expect((await f.configured(source, env, gh))._tag).toBe("Success")
  expect(f.requests).toHaveLength(6)
  expect(ghCalls).toBe(0)
  expect(gitCalls).toBe(0)
})

test("a custom API rate limit cannot become a Git fallback or a cache publication", async () => {
  const file = entry("one.txt", encode("original")),
    source = makeSource([file])
  let gitCalls = 0
  const f = fixture(new Map(), false, {
    mode: "auto",
    reader: {
      read: () => {
        gitCalls++
        return Effect.die("No fallback on rate limit")
      },
    },
    response: () => new Response(null, { status: 429, headers: { "retry-after": "15" } }),
  })
  const result = await f.configured(source, {
    NTN_SKILLS_GITHUB_API_URL: "https://gateway.example.test/api",
  })
  expect(result._tag).toBe("Failure")
  if (result._tag === "Success") throw new Error("Expected rate limit")
  expect(result.failure).toMatchObject({
    code: "GITHUB_RATE_LIMITED",
    details: { retry_after: 15 },
  })
  expect(gitCalls).toBe(0)
  expect(f.requests).toHaveLength(1)
  expect(f.writes).toHaveLength(0)
})

test("auto transport can read the same frozen bytes through Git after raw-network failure; warm reads stay provider-free", async () => {
  const bytes = encode("same original bytes"),
    file = entry("only.txt", bytes),
    source = makeSource([file])
  const requested: string[][] = []
  const f = fixture(new Map(), false, {
    mode: "auto",
    networkFailure: true,
    reader: {
      read: (input) =>
        Effect.sync(() => {
          expect(input.source.commit).toBe(source.commit)
          requested.push(input.files.map((file) => file.path))
          return new Map([[file.git_oid, bytes]])
        }),
    },
  })
  expect((await f.materialize(source))[0]!.bytes).toEqual(bytes)
  expect(requested).toEqual([["only.txt"]])
  expect(f.requests).toHaveLength(1)
  await f.materialize(source)
  expect(requested).toHaveLength(1)
  expect(f.requests).toHaveLength(1)
  f.objects.set("objects/" + digest(bytes), encode("corrupt"))
  expect((await f.rejected(source)).code).toBe("SOURCE_CACHE_CORRUPT")
  expect(requested).toHaveLength(1)
})

test("auto batch transfer falls back to exact HTTP only for Git transport failures, never for Git identity failures", async () => {
  const bodies = new Map(
    Array.from(
      { length: 5 },
      (_, i) => [`skills/demo/file-${i}.txt`, encode("content-" + i)] as const,
    ),
  )
  const source = makeSource(
    [...bodies].map(([path, bytes]) => entry(path.slice("skills/demo/".length), bytes)),
  )
  let transfers = 0
  const f = fixture(bodies, false, {
    mode: "auto",
    reader: {
      read: () => {
        transfers++
        return Effect.fail(fail("UPSTREAM_GIT_FAILED", "Controlled missing git transport"))
      },
    },
  })
  expect(await f.materialize(source)).toHaveLength(5)
  expect(transfers).toBe(1)
  expect(f.requests).toHaveLength(5)
  await f.materialize(source)
  expect(transfers).toBe(1)
  expect(f.requests).toHaveLength(5)
  const corrupt = fixture(bodies, false, {
    mode: "auto",
    reader: { read: () => Effect.fail(fail("FIXED_GIT_TREE_MISMATCH", "Wrong original tree")) },
  })
  expect((await corrupt.rejected(source)).code).toBe("FIXED_GIT_TREE_MISMATCH")
  expect(corrupt.requests).toHaveLength(0)
  const forced = fixture(bodies, false, {
    mode: "git",
    reader: { read: () => Effect.fail(fail("UPSTREAM_GIT_FAILED", "Controlled unavailable git")) },
  })
  expect((await forced.rejected(source)).code).toBe("UPSTREAM_GIT_FAILED")
  expect(forced.requests).toHaveLength(0)
})

test("private origins use only the host Git reader even when GitHub credentials and API configuration exist", async () => {
  const bytes = encode("private original\n"),
    file = entry("SKILL.md", bytes),
    source = { ...makeSource([file]), url: "http://private.example.test:8888/team/skills.git" }
  let reads = 0
  const f = fixture(new Map(), false, {
    mode: "auto",
    reader: {
      read: (input) =>
        Effect.sync(() => {
          reads++
          expect(input.source.url).toBe(source.url)
          return new Map([[file.git_oid, bytes]])
        }),
    },
  })
  const credentials = { resolve: Effect.die("Private origin must not inspect GitHub credentials") }
  const env = {
    NTN_SKILLS_GITHUB_API_URL: "https://github-gateway.example.test/api",
    GH_TOKEN: "not-for-private-host",
  }
  expect((await f.configured(source, env, credentials))._tag).toBe("Success")
  expect(reads).toBe(1)
  expect(f.requests).toEqual([])
  expect((await f.configured(source, env, credentials))._tag).toBe("Success")
  expect(reads).toBe(1)
  const forcedHttp = fixture(new Map(), false, { mode: "http" })
  expect((await forcedHttp.rejected(source)).code).toBe("FIXED_GIT_TRANSPORT_UNAVAILABLE")
  expect(forcedHttp.requests).toEqual([])
})

describe("fixed GitHub source materialization", () => {
  test("a manager-verified SHA reuses equivalent bytes already read through another transport", async () => {
    const bytes = encode("already observed exact native bytes\n")
    const file = { ...entry("same.md", bytes), sha256: digest(bytes), mode: "100755" as const }
    const source = makeSource([file])
    const f = fixture(new Map())
    f.objects.set(`objects/${file.sha256}`, bytes)
    const result = await f.materialize(source)
    expect(result[0]).toMatchObject({ sha256: file.sha256, git_oid: file.git_oid, mode: "100755" })
    expect(result[0]?.bytes).toEqual(bytes)
    expect(f.requests).toHaveLength(0)
    expect(f.json.get(key(file.git_oid))).toMatchObject({
      sha256: file.sha256,
      bytes: bytes.length,
    })
    const other = encode("same SHA label cannot authorize different bytes\n")
    const broken = fixture(new Map())
    broken.objects.set(`objects/${file.sha256}`, other)
    expect((await broken.rejected(source)).code).toBe("SOURCE_CACHE_CORRUPT")
    expect(broken.requests).toHaveLength(0)
  })

  test("Git and SHA identities must agree before cache publication and across aliases", async () => {
    const bytes = new Uint8Array([0, 255, 7])
    const file = { ...entry("raw.bin", bytes), sha256: "0".repeat(64) }
    const f = fixture(new Map([[file.source_path, bytes]]))
    expect((await f.rejected(makeSource([file]))).code).toBe("GITHUB_BLOB_MISMATCH")
    expect(f.objects.size).toBe(0)
    expect(f.json.size).toBe(0)
    const alias = { ...entry("copy.bin", bytes), sha256: digest(bytes) }
    const before = f.requests.length
    expect((await f.rejected(makeSource([file, alias]))).code).toBe("INVALID_GITHUB_SOURCE")
    expect(f.requests.length).toBe(before)
  })

  test("selective Git acquisition reads only requested blob identities and preserves corruption checks", async () => {
    const selected = encode("requested\n"),
      unused = encode("not requested\n")
    const one = entry("copy.md", selected),
      two = entry("nested/copy.md", selected)
    const excluded = entry("unused.bin", unused)
    const source = makeSource([one, two, excluded])
    const f = fixture(new Map([[one.source_path, selected]]))
    f.json.set(key(excluded.git_oid), { version: "corrupt unused mapping" })
    const files = await f.materialize(source, [two.path, one.path])
    expect(files.map((file) => file.path)).toEqual([one.path, two.path])
    expect(files.every((file) => file.sha256 === digest(selected))).toBe(true)
    expect(f.requests).toEqual([
      `https://raw.githubusercontent.com/example/skills/${source.commit}/${one.source_path}`,
    ])
    expect(f.cacheReads).toEqual([key(one.git_oid)])
    expect(f.objectReads).toEqual([])
    expect(f.objects.size).toBe(1)
    f.cacheReads.length = 0
    expect(await f.materialize(source, [two.path, one.path])).toEqual(files)
    expect(f.cacheReads).toEqual([key(one.git_oid)])
    expect(f.objectReads).toEqual([`objects/${digest(selected)}`])
    expect(f.requests).toHaveLength(1)
    f.objects.set(`objects/${digest(selected)}`, new Uint8Array(selected.length))
    expect((await f.rejected(source, [one.path])).code).toBe("SOURCE_CACHE_CORRUPT")
    expect(f.requests).toHaveLength(1)
  })

  test("selective Git admission still validates excluded metadata and exact requested membership", async () => {
    const bytes = encode("fixed\n"),
      first = entry("SKILL.md", bytes)
    const f = fixture(new Map([[first.source_path, bytes]]))
    const invalid = makeSource([
      first,
      { ...first, path: "unused.md", source_path: `${root}/unused.md`, bytes: bytes.length + 1 },
    ])
    for (const paths of [[], [first.path]])
      expect((await f.rejected(invalid, paths)).code).toBe("INVALID_GITHUB_SOURCE")
    const source = makeSource([first])
    for (const paths of [["absent.md"], [first.path, first.path]])
      expect((await f.rejected(source, paths)).code).toBe("FILE_NOT_FOUND")
    expect(await f.materialize(source, [])).toEqual([])
    expect(f.cacheReads).toEqual([])
    expect(f.objectReads).toEqual([])
    expect(f.requests).toEqual([])
    expect(f.writes).toEqual([])
  })

  test("copies the complete selected scope, deduplicates blobs, and keeps a warm run provider-free", async () => {
    const main = encode("# Fixed source\r\n")
    const script = encode("#!/bin/sh\r\nexit 91\r\n")
    const binary = new Uint8Array([0, 255, 10, 13])
    const files = [
      entry("SKILL.md", main),
      entry("copy.md", main),
      entry("scripts/check.sh", script),
      entry("assets/file.bin", binary),
    ]
    const source = makeSource(files)
    const f = fixture(
      new Map(
        files.map((file) => [
          file.source_path,
          file.path === "scripts/check.sh"
            ? script
            : file.path === "assets/file.bin"
              ? binary
              : main,
        ]),
      ),
    )
    const cold = await f.materialize(source)
    expect(cold.map((file) => file.path)).toEqual([
      "SKILL.md",
      "assets/file.bin",
      "copy.md",
      "scripts/check.sh",
    ])
    expect(cold.find((file) => file.path === "scripts/check.sh")?.bytes).toEqual(script)
    expect(cold.find((file) => file.path === "assets/file.bin")?.bytes).toEqual(binary)
    expect(f.requests).toHaveLength(3)
    expect(
      f.requests.every((url) =>
        url.startsWith(
          `https://raw.githubusercontent.com/example/skills/${source.commit}/${root}/`,
        ),
      ),
    ).toBe(true)
    expect(f.json.size).toBe(3)
    expect(f.objects.size).toBe(3)
    for (const file of cold) {
      expect(digest(file.bytes)).toBe(file.sha256)
      expect(f.objects.get(`objects/${file.sha256}`)).toEqual(file.bytes)
      expect(f.writes.indexOf(`objects/${file.sha256}`)).toBeLessThan(
        f.writes.indexOf(key(file.git_oid)),
      )
    }
    const before = f.metrics.snapshot()
    const warm = await f.materialize(source)
    expect(warm).toEqual(cold)
    expect(f.requests).toHaveLength(3)
    expect(f.metrics.snapshot()).toEqual(before)
  })

  test("cache loss reconstructs the same exact source without branch or tree discovery", async () => {
    const bytes = encode("fixed\n")
    const file = entry("SKILL.md", bytes)
    const source = makeSource([file])
    const f = fixture(new Map([[file.source_path, bytes]]))
    const first = await f.materialize(source)
    f.json.clear()
    f.objects.clear()
    expect(await f.materialize(source)).toEqual(first)
    expect(f.requests).toHaveLength(2)
    expect(
      f.requests.every((url) =>
        url.includes(`/example/skills/${source.commit}/${file.source_path}`),
      ),
    ).toBe(true)
  })

  test("a new fixed revision reuses unchanged blobs and only downloads added bytes", async () => {
    const unchanged = encode("same\n")
    const added = encode("new\n")
    const firstFile = entry("SKILL.md", unchanged)
    const nextFile = entry("new.txt", added)
    const f = fixture(
      new Map([
        [firstFile.source_path, unchanged],
        [nextFile.source_path, added],
      ]),
    )
    await f.materialize(makeSource([firstFile]))
    const next = {
      ...makeSource([firstFile, nextFile]),
      commit: "4".repeat(40),
      tree: "5".repeat(40),
    }
    const files = await f.materialize(next)
    expect(files).toHaveLength(2)
    expect(f.requests).toHaveLength(2)
    expect(f.requests[1]).toBe(
      `https://raw.githubusercontent.com/example/skills/${next.commit}/${nextFile.source_path}`,
    )
  })

  test("verifies cached SHA-256 and refuses same-length object corruption without provider fallback", async () => {
    const bytes = encode("trusted\n")
    const file = entry("SKILL.md", bytes)
    const source = makeSource([file])
    const f = fixture(new Map([[file.source_path, bytes]]))
    await f.materialize(source)
    f.objects.set(`objects/${digest(bytes)}`, new Uint8Array(bytes.length))
    const error = await f.rejected(source)
    expect(error.code).toBe("SOURCE_CACHE_CORRUPT")
    expect(f.requests).toHaveLength(1)
  })

  test("also verifies Git SHA-1 when a corrupted mapping points at a valid different SHA-256 object", async () => {
    const bytes = encode("trusted\n")
    const other = encode("altered\n")
    const file = entry("SKILL.md", bytes)
    const source = makeSource([file])
    const f = fixture(new Map([[file.source_path, bytes]]))
    await f.materialize(source)
    f.objects.set(`objects/${digest(other)}`, other)
    f.json.set(key(file.git_oid), {
      version: 1,
      git_oid: file.git_oid,
      sha256: digest(other),
      bytes: other.length,
    })
    const error = await f.rejected(source)
    expect(error.code).toBe("SOURCE_CACHE_CORRUPT")
    expect(f.requests).toHaveLength(1)
  })

  test("recovers a missing immutable object from its fixed source without replacing its stored mapping", async () => {
    const bytes = encode("fixed\n")
    const file = entry("SKILL.md", bytes)
    const source = makeSource([file])
    const f = fixture(new Map([[file.source_path, bytes]]))
    await f.materialize(source)
    const mapping = structuredClone(f.json.get(key(file.git_oid)))
    const priorWrites = f.writes.filter((path) => path.startsWith("cache/")).length
    f.objects.clear()
    const recovered = await f.materialize(source)
    expect(recovered[0]?.bytes).toEqual(bytes)
    expect(f.requests).toHaveLength(2)
    expect(f.json.size).toBe(1)
    expect(f.json.get(key(file.git_oid))).toEqual(mapping)
    expect(f.writes.filter((path) => path.startsWith("cache/")).length).toBe(priorWrites)
  })

  test("two simultaneous consumers of one fixed source share the actual bytes request", async () => {
    const bytes = encode("same fixed requested bytes\n")
    const file = entry("SKILL.md", bytes)
    const source = makeSource([file])
    const f = fixture(new Map([[file.source_path, bytes]]), true)
    const [first, second] = await Promise.all([f.materialize(source), f.materialize(source)])
    expect(first).toEqual(second)
    expect(first[0]?.bytes).toEqual(bytes)
    expect(f.requests).toHaveLength(1)
    expect(f.metrics.snapshot().total_requests).toBe(1)
  })

  test("different fixed revisions and HTTP clients do not share a pending source fetch", async () => {
    const bytes = encode("same content, separate authority\n")
    const file = entry("SKILL.md", bytes)
    const source = makeSource([file])
    const f = fixture(new Map([[file.source_path, bytes]]), true)
    const g = fixture(new Map([[file.source_path, bytes]]), true)
    await Promise.all([
      f.materialize(source),
      f.materialize({ ...source, commit: "3".repeat(40) }),
      g.materialize(source),
    ])
    expect(f.requests).toHaveLength(2)
    expect(g.requests).toHaveLength(1)
  })

  test.each(["git_oid", "sha256", "bytes", "version"])(
    "rejects a malformed derived mapping: %s",
    async (field) => {
      const bytes = encode("fixed\n")
      const file = entry("SKILL.md", bytes)
      const source = makeSource([file])
      const f = fixture(new Map([[file.source_path, bytes]]))
      await f.materialize(source)
      const mapping = { ...property(f.json.get(key(file.git_oid))), [field]: "invalid" }
      f.json.set(key(file.git_oid), mapping)
      expect((await f.rejected(source)).code).toBe("SOURCE_CACHE_CORRUPT")
      expect(f.requests).toHaveLength(1)
    },
  )

  test("rejects one Git blob declared with different sizes before any provider request", async () => {
    const bytes = encode("fixed\n")
    const first = entry("SKILL.md", bytes)
    const source = makeSource([
      first,
      { ...first, path: "copy.md", source_path: `${root}/copy.md`, bytes: bytes.length + 1 },
    ])
    const f = fixture(new Map([[first.source_path, bytes]]))
    expect((await f.rejected(source)).code).toBe("INVALID_GITHUB_SOURCE")
    expect(f.requests).toHaveLength(0)
    expect(f.json.size).toBe(0)
  })

  test("uses bounded Effect concurrency for full-scope downloads", async () => {
    const bodies = new Map<string, Uint8Array>()
    const files: FixedGithubFile[] = []
    for (let index = 0; index < 9; index += 1) {
      const bytes = encode(`file ${index}\n`)
      const file = entry(`${index}.txt`, bytes)
      files.push(file)
      bodies.set(file.source_path, bytes)
    }
    const f = fixture(bodies, true)
    expect(await f.materialize(makeSource(files))).toHaveLength(9)
    expect(f.requests).toHaveLength(9)
    expect(f.peak()).toBe(4)
    expect(f.metrics.snapshot()).toMatchObject({
      total_requests: 9,
      peak_concurrency: 4,
      in_flight: 0,
    })
  })

  test("does not publish a cache mapping for bytes that fail the pinned blob identity", async () => {
    const bytes = encode("trusted\n")
    const wrong = encode("altered\n")
    const file = entry("SKILL.md", bytes)
    const f = fixture(new Map([[file.source_path, wrong]]))
    expect((await f.rejected(makeSource([file]))).code).toBe("GITHUB_BLOB_MISMATCH")
    expect(f.json.size).toBe(0)
    expect(f.objects.size).toBe(0)
  })
})
