import { describe, expect, test } from "bun:test"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Crypto, Effect } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http"
import { createRequestMetrics } from "../src/request-metrics.ts"
import {
  fetchFixedGithubFile,
  inspectFixedGithubSource,
  validateFixedGithubSource,
  type FixedGithubFile,
  type FixedGithubSource,
} from "../src/shared-github-source.ts"

const commit = "1".repeat(40)
const tree = "2".repeat(40)
const directory = "3".repeat(40)
const textOid = "d670460b4b4aece5915caf5c68d12f560a9fe3e4"
const emptyOid = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"
const textBytes = new TextEncoder().encode("test content\n")
const input = { url: "https://github.com/example/skills.git", commit, root: "skills/demo" }
const file: FixedGithubFile = {
  path: "SKILL.md",
  source_path: "skills/demo/SKILL.md",
  git_oid: textOid,
  bytes: 13,
}
const source: FixedGithubSource = {
  url: "https://github.com/example/skills",
  commit,
  root: "skills/demo",
  tree,
  files: [file],
}
const entry = (path: string, changes: Record<string, unknown> = {}) => ({
  path,
  mode: "100644",
  type: "blob",
  sha: textOid,
  size: 13,
  ...changes,
})
const rootEntry = { path: "skills/demo", mode: "040000", type: "tree", sha: directory }
const treeBody = (entries: readonly unknown[], changes: Record<string, unknown> = {}) => ({
  sha: tree,
  truncated: false,
  tree: entries,
  ...changes,
})
const commitResponse = () => Response.json({ sha: commit, tree: { sha: tree } })

function controlled(responses: readonly Response[]) {
  const requests: { readonly url: string; readonly headers: Readonly<Record<string, string>> }[] =
    []
  const api = HttpClient.make((request, url) =>
    Effect.sync(() => {
      requests.push({ url: url.toString(), headers: request.headers })
      const response = responses[requests.length - 1]
      if (response === undefined) throw new Error("Unexpected HTTP request.")
      return HttpClientResponse.fromWeb(request, response)
    }),
  )
  return { api, requests }
}

function run<A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient | Crypto.Crypto>,
  api: HttpClient.HttpClient,
) {
  return Effect.runPromise(
    effect.pipe(
      Effect.provideService(HttpClient.HttpClient, api),
      Effect.provide(NodeServices.layer),
    ),
  )
}

describe("persisted fixed GitHub descriptor", () => {
  test("decodes and sorts the exact stored revision without any network operation", () => {
    const second = { ...file, path: "z.md", source_path: "skills/demo/z.md" }
    expect(validateFixedGithubSource({ ...source, files: [second, file] })).toEqual({
      ...source,
      files: [file, second],
    })
  })

  const malformedSources: readonly unknown[] = [
    { ...source, commit: "main" },
    { ...source, url: `${source.url}.git` },
    { ...source, tree: "tree" },
    { ...source, files: [file, file] },
    { ...source, files: [{ ...file, bytes: 0.5 }] },
    { ...source, files: [{ ...file, source_path: "other/SKILL.md" }] },
    {
      ...source,
      files: [file, { ...file, path: "skill.md", source_path: "skills/demo/skill.md" }],
    },
    {
      ...source,
      files: [
        { ...file, path: "run", source_path: "skills/demo/run" },
        { ...file, path: "run/file", source_path: "skills/demo/run/file" },
      ],
    },
  ]
  test.each(malformedSources)("refuses malformed stored source facts", (input) => {
    expect(() => validateFixedGithubSource(input)).toThrow()
  })
})

describe("fixed public GitHub source inspection", () => {
  test("uses exactly commit and complete tree requests, with no blob downloads", async () => {
    const http = controlled([
      commitResponse(),
      Response.json(
        treeBody([
          entry("outside.txt"),
          { path: "skills", mode: "040000", type: "tree", sha: directory },
          rootEntry,
          entry("skills/demo/z.sh", { mode: "100755" }),
          entry("skills/demo/SKILL.md"),
          entry("outside-link", { mode: "120000" }),
        ]),
      ),
    ])
    const metrics = createRequestMetrics()
    const result = await run(inspectFixedGithubSource({ ...input, metrics }), http.api)
    expect(result).toEqual({
      ...source,
      files: [file, { ...file, path: "z.sh", source_path: "skills/demo/z.sh" }],
    })
    expect(http.requests.map((request) => request.url)).toEqual([
      `https://api.github.com/repos/example/skills/git/commits/${commit}`,
      `https://api.github.com/repos/example/skills/git/trees/${tree}?recursive=1`,
    ])
    for (const request of http.requests) {
      expect(request.headers.authorization).toBeUndefined()
      expect(request.headers.cookie).toBeUndefined()
    }
    expect(metrics.snapshot()).toMatchObject({
      total_requests: 2,
      provider_requests: { github: 2 },
      request_bytes: 0,
      unknown_request_bytes: 0,
      unknown_response_bytes: 0,
      in_flight: 0,
      outcomes: { success: 2, failure: 0, cancelled: 0 },
    })
    expect(metrics.snapshot().response_bytes).toBeGreaterThan(0)
  })

  test("supports an explicitly pinned repository root", async () => {
    const http = controlled([commitResponse(), Response.json(treeBody([entry("SKILL.md")]))])
    const result = await run(inspectFixedGithubSource({ ...input, root: "" }), http.api)
    expect(result.files).toEqual([{ ...file, source_path: "SKILL.md" }])
  })

  test.each([
    { url: "http://github.com/example/skills" },
    { url: "https://token@github.com/example/skills" },
    { url: "https://github.com/example/skills?token=private" },
    { url: "https://github.com/example/skills/tree/main" },
    { url: "https://github.com.evil.test/example/skills" },
    { url: "https://github.com:443/example/skills" },
    { commit: "main" },
    { commit: "1234567" },
    { root: "../secret" },
    { root: "skills//demo" },
    { root: "./skills/demo" },
    { root: "skills/demo/" },
  ])("rejects an unpinned or noncanonical input before requesting: %j", async (changes) => {
    const http = controlled([])
    const error = await run(
      Effect.flip(inspectFixedGithubSource({ ...input, ...changes })),
      http.api,
    )
    expect(error.code).toBe("INVALID_GITHUB_SOURCE")
    expect(http.requests).toHaveLength(0)
  })

  test("refuses a commit response for a different revision", async () => {
    const http = controlled([Response.json({ sha: "4".repeat(40), tree: { sha: tree } })])
    const error = await run(Effect.flip(inspectFixedGithubSource(input)), http.api)
    expect(error.code).toBe("GITHUB_COMMIT_MISMATCH")
    expect(http.requests).toHaveLength(1)
  })

  test("reports GitHub's exhausted public quota without exposing the raw error body", async () => {
    const http = controlled([
      new Response(
        JSON.stringify({
          message: "API rate limit exceeded for a private network address.",
          documentation_url:
            "https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting",
        }),
        {
          status: 403,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-limit": "60",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1793453076",
          },
        },
      ),
    ])
    const metrics = createRequestMetrics()
    const error = await run(Effect.flip(inspectFixedGithubSource({ ...input, metrics })), http.api)
    expect(error.code).toBe("GITHUB_RATE_LIMITED")
    expect(error.details).toEqual({ status: 403, reset: 1793453076 })
    expect(error.message).not.toContain("private network address")
    expect(http.requests).toHaveLength(1)
    expect(metrics.snapshot()).toMatchObject({
      total_requests: 1,
      in_flight: 0,
      unknown_response_bytes: 1,
      outcomes: { failure: 1 },
    })
  })

  const rateLimitCases: readonly {
    readonly status: number
    readonly headers: Readonly<Record<string, string>>
    readonly details: Readonly<Record<string, number>>
  }[] = [
    {
      status: 403,
      headers: { "retry-after": "120", "x-ratelimit-remaining": "42" },
      details: { status: 403, retry_after: 120 },
    },
    { status: 429, headers: {}, details: { status: 429 } },
    {
      status: 429,
      headers: { "retry-after": "secret-value", "x-ratelimit-reset": "not-a-timestamp" },
      details: { status: 429 },
    },
  ]
  test.each(rateLimitCases)(
    "reports secondary rate limiting and safe retry details: $status",
    async ({ status, headers, details }) => {
      const http = controlled([new Response(null, { status, headers })])
      const error = await run(Effect.flip(inspectFixedGithubSource(input)), http.api)
      expect(error.code).toBe("GITHUB_RATE_LIMITED")
      expect(error.details).toEqual(details)
      expect(http.requests).toHaveLength(1)
    },
  )

  test("does not misclassify a permission failure with quota remaining", async () => {
    const http = controlled([
      new Response(null, {
        status: 403,
        headers: { "x-ratelimit-remaining": "59", "x-ratelimit-reset": "1793453076" },
      }),
    ])
    const error = await run(Effect.flip(inspectFixedGithubSource(input)), http.api)
    expect(error.code).toBe("GITHUB_PUBLIC_SOURCE_UNAVAILABLE")
  })

  test.each([
    { changes: { truncated: true }, code: "GITHUB_TREE_INCOMPLETE" },
    { changes: { sha: "4".repeat(40) }, code: "GITHUB_TREE_MISMATCH" },
    { changes: { truncated: undefined }, code: "GITHUB_INVALID_RESPONSE" },
  ])("rejects incomplete or substituted trees: $code", async ({ changes, code }) => {
    const http = controlled([
      commitResponse(),
      Response.json(treeBody([rootEntry, entry(file.source_path)], changes)),
    ])
    const error = await run(Effect.flip(inspectFixedGithubSource(input)), http.api)
    expect(error.code).toBe(code)
  })

  test("lists selected symlinks and submodules as unsupported", async () => {
    const http = controlled([
      commitResponse(),
      Response.json(
        treeBody([
          rootEntry,
          entry("skills/demo/link", { mode: "120000" }),
          entry("skills/demo/module", { mode: "160000", type: "commit" }),
        ]),
      ),
    ])
    const error = await run(Effect.flip(inspectFixedGithubSource(input)), http.api)
    expect(error.code).toBe("GITHUB_UNSUPPORTED_ENTRIES")
    expect(error.details).toEqual({
      entries: [
        { path: "link", type: "blob", mode: "120000" },
        { path: "module", type: "commit", mode: "160000" },
      ],
    })
    expect(http.requests).toHaveLength(2)
  })

  test.each([
    { entries: [entry("elsewhere/SKILL.md")], code: "GITHUB_ROOT_NOT_FOUND" },
    { entries: [entry("skills/demo")], code: "GITHUB_ROOT_NOT_DIRECTORY" },
    {
      entries: [rootEntry, entry(file.source_path), entry(file.source_path)],
      code: "GITHUB_DUPLICATE_PATH",
    },
    { entries: [rootEntry, entry("skills/demo/../outside")], code: "GITHUB_INVALID_PATH" },
    {
      entries: [rootEntry, entry(file.source_path, { size: -1 })],
      code: "GITHUB_INVALID_RESPONSE",
    },
    {
      entries: [rootEntry, entry("skills/demo/A/file"), entry("skills/demo/a/other")],
      code: "GITHUB_PATH_COLLISION",
    },
    { entries: [rootEntry, entry("skills/demo/.git/config")], code: "GITHUB_INVALID_PATH" },
  ])("rejects incomplete or unsafe selected roots: $code", async ({ entries, code }) => {
    const http = controlled([commitResponse(), Response.json(treeBody(entries))])
    const error = await run(Effect.flip(inspectFixedGithubSource(input)), http.api)
    expect(error.code).toBe(code)
  })
})

describe("fixed public GitHub file fetch", () => {
  test("fetches only the selected entry at the fixed commit and verifies its Git blob ID", async () => {
    const http = controlled([new Response(textBytes, { headers: { "content-length": "13" } })])
    const metrics = createRequestMetrics()
    const result = await run(fetchFixedGithubFile(source, file, { metrics }), http.api)
    expect(result).toEqual(textBytes)
    expect(http.requests.map((request) => request.url)).toEqual([
      `https://raw.githubusercontent.com/example/skills/${commit}/skills/demo/SKILL.md`,
    ])
    expect(metrics.snapshot()).toMatchObject({
      total_requests: 1,
      response_bytes: 13,
      unknown_response_bytes: 0,
      provider_requests: { github: 1 },
      in_flight: 0,
    })
  })

  test.each([
    { path: "empty", bytes: new Uint8Array(), oid: emptyOid },
    {
      path: "binary.dat",
      bytes: new Uint8Array([0, 255, 10, 13, 0, 65]),
      oid: "70a4c3f7157bd4bbb9672b52f7b3663da7e37d1f",
    },
    {
      path: "run.sh",
      bytes: new TextEncoder().encode("#!/bin/sh\r\nprintf ok\r\n"),
      oid: "8065372ac72118e26d2273c1c3c196a4444e7d92",
    },
    {
      path: "a b/#doc?.md",
      bytes: new TextEncoder().encode("what is up, doc?"),
      oid: "bd9dbf5aae1a3862dd1526723246b20206e5fc37",
    },
  ])("preserves original bytes and encodes path segments: $path", async ({ path, bytes, oid }) => {
    const selected = { path, source_path: `skills/demo/${path}`, git_oid: oid, bytes: bytes.length }
    const http = controlled([new Response(bytes)])
    const result = await run(
      fetchFixedGithubFile({ ...source, files: [selected] }, selected),
      http.api,
    )
    expect(result).toEqual(bytes)
    const expectedPath = selected.source_path.split("/").map(encodeURIComponent).join("/")
    expect(http.requests[0]?.url).toBe(
      `https://raw.githubusercontent.com/example/skills/${commit}/${expectedPath}`,
    )
  })

  test.each([
    {
      response: () => new Response(textBytes, { headers: { "content-length": "12" } }),
      code: "GITHUB_SIZE_MISMATCH",
    },
    { response: () => new Response(textBytes.slice(0, 12)), code: "GITHUB_SIZE_MISMATCH" },
    { response: () => new Response(new Uint8Array(14)), code: "GITHUB_SIZE_EXCEEDED" },
    { response: () => new Response(new Uint8Array(13)), code: "GITHUB_BLOB_MISMATCH" },
  ])("rejects partial, oversized, or substituted bytes: $code", async ({ response, code }) => {
    const http = controlled([response()])
    const error = await run(Effect.flip(fetchFixedGithubFile(source, file)), http.api)
    expect(error.code).toBe(code)
    expect(http.requests).toHaveLength(1)
  })

  test("stops and cancels a streaming body as soon as its declared size is exceeded", async () => {
    let cancelled = false
    let reads = 0
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          reads += 1
          controller.enqueue(new Uint8Array(14))
        },
        cancel() {
          cancelled = true
        },
      },
      { highWaterMark: 0 },
    )
    const metrics = createRequestMetrics()
    const http = controlled([new Response(stream)])
    const error = await run(Effect.flip(fetchFixedGithubFile(source, file, { metrics })), http.api)
    expect(error.code).toBe("GITHUB_SIZE_EXCEEDED")
    expect(cancelled).toBe(true)
    expect(reads).toBe(1)
    expect(metrics.snapshot()).toMatchObject({
      response_bytes: 14,
      in_flight: 0,
      outcomes: { failure: 1 },
    })
  })

  test.each([
    { ...file, path: "outside.txt", source_path: "outside.txt" },
    { ...file, git_oid: emptyOid },
    { ...file, bytes: 1 },
    { ...file, source_path: "skills/demo/../outside.txt" },
  ])("refuses a forged or unselected entry before a body request", async (selected) => {
    const http = controlled([])
    const error = await run(Effect.flip(fetchFixedGithubFile(source, selected)), http.api)
    expect(error.code).toBe("GITHUB_FILE_NOT_SELECTED")
    expect(http.requests).toHaveLength(0)
  })

  test("requires explicit public access and does not fall back to another credential channel", async () => {
    const metrics = createRequestMetrics()
    const http = controlled([new Response(null, { status: 404 })])
    const error = await run(Effect.flip(fetchFixedGithubFile(source, file, { metrics })), http.api)
    expect(error.code).toBe("GITHUB_PUBLIC_SOURCE_UNAVAILABLE")
    expect(http.requests).toHaveLength(1)
    expect(metrics.snapshot()).toMatchObject({
      in_flight: 0,
      unknown_response_bytes: 1,
      outcomes: { failure: 1 },
    })
  })

  test("rejects a redirect without reading a target response", async () => {
    const http = controlled([
      new Response(null, { status: 302, headers: { location: "https://evil.test/file" } }),
    ])
    const error = await run(Effect.flip(fetchFixedGithubFile(source, file)), http.api)
    expect(error.code).toBe("GITHUB_REDIRECT_REFUSED")
    expect(http.requests).toHaveLength(1)
  })

  test("sets fetch redirect to manual and omits credentials on the actual transport", async () => {
    const calls: {
      readonly url: string
      readonly redirect: RequestRedirect | undefined
      readonly credentials: RequestCredentials | undefined
    }[] = []
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: input instanceof Request ? input.url : input.toString(),
        redirect: init?.redirect,
        credentials: init?.credentials,
      })
      return new Response(null, { status: 302, headers: { location: "https://evil.test/file" } })
    }
    const error = await Effect.runPromise(
      Effect.flip(fetchFixedGithubFile(source, file)).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
        Effect.provideService(FetchHttpClient.RequestInit, {
          redirect: "follow",
          credentials: "include",
        }),
        Effect.provide(NodeServices.layer),
      ),
    )
    expect(error.code).toBe("GITHUB_REDIRECT_REFUSED")
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ redirect: "manual", credentials: "omit" })
  })

  test("aborts an interrupted fetch and closes its single metrics observation", async () => {
    const metrics = createRequestMetrics()
    const controller = new AbortController()
    let start = () => {}
    const started = new Promise<void>((resolve) => {
      start = resolve
    })
    let transportAborted = false
    const fakeFetch = (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            transportAborted = true
            reject(new Error("Controlled cancellation."))
          },
          { once: true },
        )
        start()
      })
    const completion = Effect.runPromise(
      fetchFixedGithubFile(source, file, { metrics }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
        Effect.provide(NodeServices.layer),
      ),
      { signal: controller.signal },
    ).then(
      () => "completed",
      () => "interrupted",
    )
    await started
    controller.abort()
    expect(await completion).toBe("interrupted")
    expect(transportAborted).toBe(true)
    expect(metrics.snapshot()).toMatchObject({
      total_requests: 1,
      in_flight: 0,
      unknown_response_bytes: 1,
      outcomes: { success: 0, failure: 0, cancelled: 1 },
    })
  })
})
