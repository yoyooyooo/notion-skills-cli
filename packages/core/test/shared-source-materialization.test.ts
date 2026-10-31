import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { fail, property, SkillsError } from "../src/model.ts"
import { createRequestMetrics } from "../src/request-metrics.ts"
import type { FixedGithubFile, FixedGithubSource } from "../src/shared-github-source.ts"
import { materializeFixedGithubSource } from "../src/shared-source-materialization.ts"
import { Store } from "../src/store.ts"
import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"

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

function fixture(bodyByPath: ReadonlyMap<string, Uint8Array>, delay = false) {
  const json = new Map<string, unknown>()
  const objects = new Map<string, Uint8Array>()
  const writes: string[] = []
  const requests: string[] = []
  let active = 0
  let peak = 0
  const unexpected = () => Effect.die(new Error("Unexpected Store operation."))
  const store: Store["Service"] = {
    root: "/controlled",
    configRoot: "/controlled/config",
    cacheRoot: "/controlled/cache",
    upstream: upstreamRepositoryFixture(),
    integrity: integrityRepositoryFixture(),
    reserveCacheGeneration: unexpected,
    listKeys: unexpected,
    retireKeys: unexpected,
    registerBindingWithBase: unexpected,
    advanceBaseAndReceipt: unexpected,
    backup: unexpected,
    output: unexpected,
    readJson: (key, schema) =>
      Effect.try({
        try: () => {
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
      active += 1
      peak = Math.max(peak, active)
      return yield* Effect.gen(function* () {
        if (delay) yield* Effect.sleep("5 millis")
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
  const materialize = (source: FixedGithubSource) =>
    Effect.runPromise(
      materializeFixedGithubSource(source, { metrics }).pipe(
        Effect.provideService(Store, store),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provide(NodeServices.layer),
      ),
    )
  const rejected = (source: FixedGithubSource) =>
    Effect.runPromise(
      Effect.flip(materializeFixedGithubSource(source, { metrics })).pipe(
        Effect.provideService(Store, store),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provide(NodeServices.layer),
      ),
    )
  return { json, objects, writes, requests, metrics, materialize, rejected, peak: () => peak }
}

describe("fixed GitHub source materialization", () => {
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

  test("does not treat a missing immutable object as a reason to replace a stored source fact", async () => {
    const bytes = encode("fixed\n")
    const file = entry("SKILL.md", bytes)
    const source = makeSource([file])
    const f = fixture(new Map([[file.source_path, bytes]]))
    await f.materialize(source)
    f.objects.clear()
    expect((await f.rejected(source)).code).toBe("SOURCE_CACHE_CORRUPT")
    expect(f.requests).toHaveLength(1)
    expect(f.json.size).toBe(1)
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
