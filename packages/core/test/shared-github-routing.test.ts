import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { ConfigProvider, Crypto, Effect } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http"
import { createRequestMetrics } from "../src/request-metrics.ts"
import {
  fetchFixedGithubFile,
  inspectFixedGithubSource,
  type FixedGithubSource,
} from "../src/shared-github-source.ts"

const bytes = new Uint8Array([0, 255, 13, 10, 72, 73])
const oid = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")
const source: FixedGithubSource = {
  url: "https://github.com/example/fixed",
  commit: "a".repeat(40),
  tree: "b".repeat(40),
  root: "skills/demo",
  files: [
    {
      path: "asset.bin",
      source_path: "skills/demo/asset.bin",
      git_oid: oid,
      bytes: bytes.length,
      mode: "100644",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  ],
}

function fixture(env: Record<string, string>, base: string, token: string | undefined) {
  const calls: { url: string; authorization: string | undefined; accept: string | undefined }[] = []
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      calls.push({
        url: url.href,
        authorization: request.headers.authorization,
        accept: request.headers.accept,
      })
      const authorized =
        request.headers.authorization === (token === undefined ? undefined : "Bearer " + token)
      if (url.href === base + "/repos/example/fixed/git/blobs/" + oid && authorized)
        return HttpClientResponse.fromWeb(
          request,
          base === "https://api.github.com"
            ? new Response(bytes, { headers: { "content-length": String(bytes.length) } })
            : Response.json({
                sha: oid,
                size: bytes.length,
                encoding: "base64",
                content: Buffer.from(bytes).toString("base64") + "\n",
              }),
        )
      if (url.href === base + "/repos/example/fixed/git/commits/" + source.commit && authorized)
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ sha: source.commit, tree: { sha: source.tree } }),
        )
      if (
        url.href === base + "/repos/example/fixed/git/trees/" + source.tree + "?recursive=1" &&
        authorized
      )
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            sha: source.tree,
            truncated: false,
            tree: [
              { path: source.root, mode: "040000", type: "tree", sha: "c".repeat(40) },
              ...source.files.map((file) => ({
                path: file.source_path,
                mode: file.mode,
                type: "blob",
                sha: file.git_oid,
                size: file.bytes,
              })),
            ],
          }),
        )
      return HttpClientResponse.fromWeb(request, new Response(null, { status: 404 }))
    }),
  )
  const run = <A, E>(action: Effect.Effect<A, E, HttpClient.HttpClient | Crypto.Crypto>) =>
    Effect.runPromise(
      action.pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provide(NodeServices.layer),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
      ),
    )
  return { calls, run }
}

test("custom API prefix owns both exact tree metadata and binary blob reads without ambient GitHub credentials", async () => {
  const base = "https://gateway.example.test/github/api/v3"
  const f = fixture(
    { NTN_SKILLS_GITHUB_API_URL: base, GH_TOKEN: "must-not-leave-official-host" },
    base,
    undefined,
  )
  const inspected = await f.run(inspectFixedGithubSource(source))
  expect(inspected.files).toEqual(source.files.map(({ sha256: _sha, ...file }) => file))
  expect(await f.run(fetchFixedGithubFile(source, source.files[0]!))).toEqual(bytes)
  expect(f.calls).toHaveLength(3)
  expect(
    f.calls.every(
      (call) => call.url.startsWith(base + "/repos/") && call.authorization === undefined,
    ),
  ).toBe(true)
  expect(f.calls[2]!.accept).toBe("application/vnd.github+json")
})

test("official API uses GH_TOKEN before GITHUB_TOKEN and fetches the fixed blob rather than authenticated raw CDN", async () => {
  const base = "https://api.github.com"
  const f = fixture(
    { GH_TOKEN: "preferred-environment-token", GITHUB_TOKEN: "secondary-environment-token" },
    base,
    "preferred-environment-token",
  )
  expect(await f.run(fetchFixedGithubFile(source, source.files[0]!))).toEqual(bytes)
  expect(f.calls).toHaveLength(1)
  expect(f.calls[0]!.url).toBe(base + "/repos/example/fixed/git/blobs/" + oid)
})

test("custom API only receives its explicitly supplied dedicated token", async () => {
  const base = "https://gateway.example.test/api"
  const f = fixture(
    {
      NTN_SKILLS_GITHUB_API_URL: base,
      NTN_SKILLS_GITHUB_TOKEN: "explicit-gateway-token",
      GH_TOKEN: "official-secret",
    },
    base,
    "explicit-gateway-token",
  )
  expect(await f.run(fetchFixedGithubFile(source, source.files[0]!))).toEqual(bytes)
  expect(f.calls[0]!.authorization).toBe("Bearer explicit-gateway-token")
})

function responseFixture(response: () => Response, environment: Record<string, string> = {}) {
  const calls: string[] = [],
    metrics = createRequestMetrics({ traceLimit: 100 })
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      calls.push(url.href)
      return HttpClientResponse.fromWeb(request, response())
    }),
  )
  const run = () =>
    Effect.runPromise(
      fetchFixedGithubFile(source, source.files[0]!, { metrics }).pipe(
        Effect.result,
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provide(NodeServices.layer),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              NTN_SKILLS_GITHUB_API_URL: "https://gateway.example.test/api",
              NTN_SKILLS_GITHUB_TOKEN: "synthetic-secret-not-in-diagnostics",
              ...environment,
            }),
          ),
        ),
      ),
    )
  return { calls, metrics, run }
}

test.each([
  [301, { location: "https://other.example.test/collect" }, "GITHUB_REDIRECT_REFUSED"],
  [401, {}, "GITHUB_AUTHENTICATION_FAILED"],
  [403, { "x-ratelimit-remaining": "12" }, "GITHUB_ACCESS_FORBIDDEN"],
  [403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000000" }, "GITHUB_RATE_LIMITED"],
  [429, { "retry-after": "8" }, "GITHUB_RATE_LIMITED"],
  [503, {}, "GITHUB_HTTP_ERROR"],
] as const)(
  "API HTTP %s preserves the exact failure instead of changing credentials or hosts",
  async (status, headers, code) => {
    const f = responseFixture(
      () =>
        new Response("provider echoes synthetic-secret-not-in-diagnostics", { status, headers }),
    )
    const result = await f.run()
    expect(result._tag).toBe("Failure")
    if (result._tag === "Success") throw new Error("Expected failure")
    expect(result.failure.code).toBe(code)
    expect(f.calls).toHaveLength(1)
    if (status === 429) expect(result.failure.details).toMatchObject({ retry_after: 8 })
    expect(JSON.stringify({ error: result.failure, metrics: f.metrics.snapshot() })).not.toContain(
      "synthetic-secret-not-in-diagnostics",
    )
  },
)

test("authenticated actual Fetch refuses redirects without forwarding a token to the destination", async () => {
  const calls: {
    url: string
    redirect: RequestRedirect | undefined
    credentials: RequestCredentials | undefined
    authorized: boolean
  }[] = []
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: input instanceof Request ? input.url : String(input),
      redirect: init?.redirect,
      credentials: init?.credentials,
      authorized: new Headers(init?.headers).get("authorization") === "Bearer controlled-token",
    })
    return new Response(null, {
      status: 302,
      headers: { location: "https://unexpected.example.test/collect" },
    })
  }
  const result = await Effect.runPromise(
    fetchFixedGithubFile(source, source.files[0]!).pipe(
      Effect.result,
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.provide(NodeServices.layer),
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ GH_TOKEN: "controlled-token" })),
      ),
    ),
  )
  expect(result._tag).toBe("Failure")
  if (result._tag === "Success") throw new Error("Expected refused redirect")
  expect(result.failure.code).toBe("GITHUB_REDIRECT_REFUSED")
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({ redirect: "manual", credentials: "omit", authorized: true })
})

test.each([
  [{ sha: "f".repeat(40) }, "GITHUB_BLOB_MISMATCH"],
  [{ size: bytes.length + 1 }, "GITHUB_SIZE_MISMATCH"],
  [{ encoding: "utf-8" }, "GITHUB_INVALID_RESPONSE"],
  [{ content: "invalid base64" }, "GITHUB_INVALID_RESPONSE"],
  [{ content: "AA==" }, "GITHUB_SIZE_MISMATCH"],
  [
    { content: Buffer.from(new Uint8Array(bytes.length).fill(7)).toString("base64") },
    "GITHUB_BLOB_MISMATCH",
  ],
] as const)("custom JSON blob guard rejects %j", async (changes, code) => {
  const f = responseFixture(() =>
    Response.json({
      sha: oid,
      size: bytes.length,
      encoding: "base64",
      content: Buffer.from(bytes).toString("base64"),
      ...changes,
    }),
  )
  const result = await f.run()
  expect(result._tag).toBe("Failure")
  if (result._tag === "Success") throw new Error("Expected failure")
  expect(result.failure.code).toBe(code)
  expect(f.calls).toHaveLength(1)
})

test("large JSON/base64 payload uses bounded decoding without regex recursion or metadata URL following", async () => {
  const large = new Uint8Array(512 * 1024).fill(0xab),
    largeOid = createHash("sha1").update(`blob ${large.length}\0`).update(large).digest("hex")
  const largeFile = {
    ...source.files[0]!,
    bytes: large.length,
    git_oid: largeOid,
    sha256: createHash("sha256").update(large).digest("hex"),
  }
  const largeSource = { ...source, files: [largeFile] },
    urls: string[] = []
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      urls.push(url.href)
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          sha: largeOid,
          size: large.length,
          encoding: "base64",
          content: Buffer.from(large).toString("base64").replace(/.{60}/gu, "$&\n"),
          url: "https://other.example.test/ignore",
          download_url: "https://other.example.test/ignore",
        }),
      )
    }),
  )
  const read = await Effect.runPromise(
    fetchFixedGithubFile(largeSource, largeFile).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.provide(NodeServices.layer),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            NTN_SKILLS_GITHUB_API_URL: "https://gateway.example.test/api",
          }),
        ),
      ),
    ),
  )
  expect(read).toEqual(large)
  expect(urls).toEqual([
    "https://gateway.example.test/api/repos/example/fixed/git/blobs/" + largeOid,
  ])
})
