import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Crypto, Effect, Fiber, FileSystem, Latch, Path, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http"
import { fail, SkillsError } from "../src/model.ts"
import { createRequestMetrics } from "../src/request-metrics.ts"
import {
  fixedFileManifestId,
  materializeFixedHttpFiles,
  materializeFixedLocalFiles,
  validateFixedFileManifest,
  type FixedFileManifest,
  type FixedLocalResource,
  type LocalResourceBinding,
} from "../src/shared-fixed-resources.ts"
import { Store } from "../src/store.ts"
import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"

const encode = (value: string) => new TextEncoder().encode(value)
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const file = (path: string, bytes: Uint8Array) => ({
  path,
  sha256: digest(bytes),
  bytes: bytes.byteLength,
})
const manifest = (...files: FixedFileManifest["files"]): FixedFileManifest => ({
  version: 1,
  files,
})
const publicUrl = "https://raw.githubusercontent.com/example/resources/fixed/asset.bin"
const scope = { machine_scope: "machine-a", workspace_scope: "workspace-a" }
const localSource = (fixed: FixedFileManifest): FixedLocalResource => ({
  binding_key: "demo-assets",
  ...scope,
  manifest: fixed,
})
const localBinding = (absoluteRoot: string): LocalResourceBinding => ({
  binding_key: "demo-assets",
  ...scope,
  absolute_root: absoluteRoot,
})

type Requirements =
  | Store
  | Crypto.Crypto
  | HttpClient.HttpClient
  | FileSystem.FileSystem
  | Path.Path

function fixture(responses: readonly Response[] = []) {
  const objects = new Map<string, Uint8Array>()
  const json = new Map<string, unknown>()
  const writes: string[] = []
  const requests: { url: string; headers: Readonly<Record<string, string>> }[] = []
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
        try: () => (json.has(key) ? Schema.decodeUnknownSync(schema)(json.get(key)) : undefined),
        catch: () => fail("STATE_CORRUPT", "Controlled invalid restriction."),
      }),
    writeJson: (key, value) =>
      Effect.sync(() => {
        json.set(key, structuredClone(value))
        writes.push(key)
      }),
    readBytes: (key) =>
      Effect.gen(function* () {
        const bytes = objects.get(key)
        return bytes === undefined
          ? yield* Effect.fail(fail("SNAPSHOT_MISSING", "Controlled missing object."))
          : bytes.slice()
      }),
    writeBytes: (key, bytes) =>
      Effect.sync(() => {
        const previous = objects.get(key)
        if (
          previous !== undefined &&
          (previous.length !== bytes.length ||
            previous.some((byte, index) => byte !== bytes[index]))
        ) {
          throw new Error("An immutable object was overwritten.")
        }
        objects.set(key, bytes.slice())
        writes.push(key)
      }),
  }
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const response = responses[requests.length]
      requests.push({ url: url.toString(), headers: request.headers })
      if (response === undefined) throw new Error("Unexpected HTTP request.")
      return HttpClientResponse.fromWeb(request, response)
    }),
  )
  const metrics = createRequestMetrics()
  function run<A, E>(effect: Effect.Effect<A, E, Requirements>, http = client) {
    return Effect.runPromise(
      effect.pipe(
        Effect.provideService(Store, store),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provide(NodeServices.layer),
      ),
    )
  }
  return { objects, json, writes, requests, store, client, metrics, run }
}

async function withDirectory<A>(use: (root: string) => Promise<A>): Promise<A> {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ntn-fixed-resource-"))
  try {
    return await use(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe("fixed file manifest", () => {
  test("separates sorted content identity from retrieval addresses and keeps empty binary files", async () => {
    const f = fixture()
    const first = file("z.bin", new Uint8Array())
    const second = file("a.sh", encode("#!/bin/sh\r\nexit 99\r\n"))
    const fixed = manifest(first, second)
    expect(validateFixedFileManifest(fixed)).toEqual(manifest(second, first))
    expect(await f.run(fixedFileManifestId(fixed))).toBe(
      await f.run(fixedFileManifestId(manifest(second, first))),
    )
    expect(await f.run(fixedFileManifestId(fixed))).not.toBe(
      await f.run(fixedFileManifestId(manifest(first))),
    )
    expect(f.requests).toHaveLength(0)
  })

  test.each([
    "../secret",
    "/secret",
    "a/../b",
    "./file",
    "a//b",
    "a\\b",
    "a\u0000b",
    ".git/config",
    "nested/.NTN-SKILLS.JSON",
    "．git/config",
    "a/／/b",
  ])("rejects an unsafe or noncanonical path: %j", (path) => {
    expect(() => validateFixedFileManifest(manifest(file(path, encode("x"))))).toThrow()
  })

  test.each([
    { paths: ["same", "same"] },
    { paths: ["Readme.md", "README.md"] },
    { paths: ["é.txt", "é.txt"] },
    { paths: ["Dir/a", "dir/b"] },
    { paths: ["a", "a/b"] },
  ])("rejects duplicate, portable alias, and file/directory collisions: %j", ({ paths }) => {
    expect(() =>
      validateFixedFileManifest(manifest(...paths.map((path) => file(path, encode("x"))))),
    ).toThrow()
  })

  test("rejects conflicting sizes for one content hash and unknown descriptor fields", () => {
    const entry = file("a", encode("x"))
    expect(() =>
      validateFixedFileManifest(manifest(entry, { ...entry, path: "b", bytes: 2 })),
    ).toThrow()
    expect(() =>
      validateFixedFileManifest({ ...manifest(entry), absolute_root: "/private" }),
    ).toThrow()
    expect(() =>
      validateFixedFileManifest(manifest({ ...entry, sha256: entry.sha256.toUpperCase() })),
    ).toThrow()
    expect(() =>
      validateFixedFileManifest(manifest({ ...entry, bytes: Number.MAX_SAFE_INTEGER })),
    ).toThrow()
  })
})

describe("fixed public HTTP resources", () => {
  test("downloads exact binary/script bytes once per hash, then reuses verified objects without network", async () => {
    const bytes = new Uint8Array([0, 255, 13, 10, 35, 33, 10])
    const fixed = manifest(file("assets/file.bin", bytes), file("scripts/do-not-run.sh", bytes))
    const f = fixture([new Response(bytes.slice())])
    const input = { manifest: fixed, locations: [{ sha256: digest(bytes), url: publicUrl }] }
    const cold = await f.run(materializeFixedHttpFiles(input, { metrics: f.metrics }))
    expect(cold.map((entry) => entry.path)).toEqual(["assets/file.bin", "scripts/do-not-run.sh"])
    for (const entry of cold) expect(entry.bytes).toEqual(bytes)
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0]?.headers.authorization).toBeUndefined()
    expect(f.requests[0]?.headers.cookie).toBeUndefined()
    const before = f.metrics.snapshot()
    const warm = await f.run(
      materializeFixedHttpFiles(
        {
          ...input,
          locations: [
            { sha256: digest(bytes), url: "https://example.com/moved.bin?token=provider-only" },
          ],
        },
        { allowedOrigins: ["https://example.com"], metrics: f.metrics },
      ),
    )
    expect(warm).toEqual(cold)
    expect(f.metrics.snapshot()).toEqual(before)
    expect(f.requests).toHaveLength(1)
    expect(f.writes).toEqual([`objects/${digest(bytes)}`])
  })

  test.each([
    "http://example.com/file",
    "https://user:secret@example.com/file",
    "https://example.com:8443/file",
    "https://127.0.0.1/file",
    "https://10.0.0.1/file",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/file",
    "https://2130706433/file",
    "https://localhost/file",
    "https://service.internal/file",
  ])("rejects unsafe retrieval addresses before all I/O: %s", async (url) => {
    const bytes = encode("fixed")
    const f = fixture()
    const result = await f.run(
      Effect.flip(
        materializeFixedHttpFiles(
          {
            manifest: manifest(file("asset", bytes)),
            locations: [{ sha256: digest(bytes), url }],
          },
          { allowedOrigins: ["https://example.com"] },
        ),
      ),
    )
    expect(result).toBeInstanceOf(SkillsError)
    expect(f.requests).toHaveLength(0)
    expect(f.writes).toHaveLength(0)
  })

  test("requires explicit machine origin authorization even when the requested hash is cached", async () => {
    const bytes = encode("fixed")
    const f = fixture()
    f.objects.set(`objects/${digest(bytes)}`, bytes)
    const error = await f.run(
      Effect.flip(
        materializeFixedHttpFiles({
          manifest: manifest(file("asset", bytes)),
          locations: [{ sha256: digest(bytes), url: "https://example.com/file" }],
        }),
      ),
    )
    expect(error.code).toBe("HTTP_RESOURCE_ORIGIN_NOT_ALLOWED")
    expect(f.requests).toHaveLength(0)
  })

  test("refuses missing or ambiguous locations before any request", async () => {
    const bytes = encode("fixed")
    const f = fixture()
    const location = { sha256: digest(bytes), url: publicUrl }
    for (const locations of [[], [location, location], [{ ...location, sha256: "0".repeat(64) }]]) {
      expect(
        (
          await f.run(
            Effect.flip(
              materializeFixedHttpFiles({ manifest: manifest(file("asset", bytes)), locations }),
            ),
          )
        ).code,
      ).toBe("INVALID_HTTP_RESOURCE_LOCATIONS")
    }
    expect(f.requests).toHaveLength(0)
  })

  test.each([301, 302, 307, 308])(
    "rejects HTTP %s without following any target",
    async (status) => {
      const bytes = encode("fixed")
      const f = fixture([
        new Response(null, { status, headers: { location: "http://127.0.0.1/private" } }),
      ])
      const result = await f.run(
        Effect.flip(
          materializeFixedHttpFiles({
            manifest: manifest(file("asset", bytes)),
            locations: [{ sha256: digest(bytes), url: publicUrl }],
          }),
        ),
      )
      expect(result.code).toBe("HTTP_RESOURCE_REDIRECT_REFUSED")
      expect(f.requests).toHaveLength(1)
      expect(f.objects.size).toBe(0)
    },
  )

  test("enforces manual redirects and omitted credentials on the native fetch transport", async () => {
    const bytes = encode("fixed")
    const f = fixture()
    const calls: RequestInit[] = []
    const fakeFetch = async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {})
      return new Response(null, { status: 302, headers: { location: "https://example.com/other" } })
    }
    const error = await f.run(
      Effect.flip(
        materializeFixedHttpFiles({
          manifest: manifest(file("asset", bytes)),
          locations: [{ sha256: digest(bytes), url: `${publicUrl}?download=1` }],
        }),
      ).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
        Effect.provideService(FetchHttpClient.RequestInit, {
          redirect: "follow",
          credentials: "include",
        }),
      ),
    )
    expect(error.code).toBe("HTTP_RESOURCE_REDIRECT_REFUSED")
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ redirect: "manual", credentials: "omit" })
  })

  test.each([
    { response: () => new Response(encode("bad!!")), code: "FIXED_RESOURCE_HASH_MISMATCH" },
    { response: () => new Response(encode("less")), code: "FIXED_RESOURCE_SIZE_MISMATCH" },
    { response: () => new Response(encode("longer")), code: "FIXED_RESOURCE_SIZE_EXCEEDED" },
    {
      response: () => new Response(encode("fixed"), { headers: { "content-length": "4" } }),
      code: "FIXED_RESOURCE_SIZE_MISMATCH",
    },
    { response: () => new Response(null, { status: 403 }), code: "HTTP_RESOURCE_UNAVAILABLE" },
  ])(
    "rejects unverified HTTP bytes without publishing an object: $code",
    async ({ response, code }) => {
      const bytes = encode("fixed")
      const f = fixture([response()])
      const error = await f.run(
        Effect.flip(
          materializeFixedHttpFiles(
            {
              manifest: manifest(file("asset", bytes)),
              locations: [{ sha256: digest(bytes), url: publicUrl }],
            },
            { metrics: f.metrics },
          ),
        ),
      )
      expect(error.code).toBe(code)
      expect(f.objects.size).toBe(0)
      expect(f.metrics.snapshot().in_flight).toBe(0)
      expect(f.requests).toHaveLength(1)
    },
  )

  test("rejects corrupted cached bytes without downloading replacement content", async () => {
    const bytes = encode("fixed")
    const f = fixture()
    f.objects.set(`objects/${digest(bytes)}`, encode("bad!!"))
    const error = await f.run(
      Effect.flip(
        materializeFixedHttpFiles({
          manifest: manifest(file("asset", bytes)),
          locations: [{ sha256: digest(bytes), url: publicUrl }],
        }),
      ),
    )
    expect(error.code).toBe("FIXED_RESOURCE_CACHE_CORRUPT")
    expect(f.requests).toHaveLength(0)
  })

  test("stops an oversized streaming body at the first excess chunk and cancels the reader", async () => {
    let reads = 0
    let cancelled = false
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          reads++
          controller.enqueue(new Uint8Array(6))
        },
        cancel() {
          cancelled = true
        },
      },
      { highWaterMark: 0 },
    )
    const bytes = encode("fixed")
    const f = fixture([new Response(body)])
    const error = await f.run(
      Effect.flip(
        materializeFixedHttpFiles(
          {
            manifest: manifest(file("asset", bytes)),
            locations: [{ sha256: digest(bytes), url: publicUrl }],
          },
          { metrics: f.metrics },
        ),
      ),
    )
    expect(error.code).toBe("FIXED_RESOURCE_SIZE_EXCEEDED")
    expect(reads).toBe(1)
    expect(cancelled).toBe(true)
    expect(f.objects.size).toBe(0)
    expect(f.metrics.snapshot()).toMatchObject({
      response_bytes: 6,
      in_flight: 0,
      outcomes: { failure: 1 },
    })
  })

  test("bounds actual HTTP attempts at four and interrupts all active I/O without caching partial bytes", async () => {
    const f = fixture()
    const started = Latch.makeUnsafe()
    let active = 0
    let peak = 0
    let calls = 0
    let cancelled = 0
    const client = HttpClient.make(() =>
      Effect.gen(function* () {
        calls++
        active++
        peak = Math.max(peak, active)
        if (active === 4) started.openUnsafe()
        return yield* Effect.never.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              active--
              cancelled++
            }),
          ),
        )
      }),
    )
    const entries = Array.from({ length: 9 }, (_, index) =>
      file(`files/${index}.bin`, encode(`fixed-${index}`)),
    )
    await f.run(
      Effect.scoped(
        Effect.gen(function* () {
          const running = yield* Effect.forkChild(
            materializeFixedHttpFiles(
              {
                manifest: manifest(...entries),
                locations: entries.map((entry) => ({
                  sha256: entry.sha256,
                  url: `${publicUrl}?file=${entry.path}`,
                })),
              },
              { metrics: f.metrics },
            ),
          )
          yield* started.await
          expect(calls).toBe(4)
          yield* Fiber.interrupt(running)
        }),
      ),
      client,
    )
    expect(peak).toBe(4)
    expect(active).toBe(0)
    expect(cancelled).toBe(4)
    expect(f.objects.size).toBe(0)
    expect(f.metrics.snapshot()).toMatchObject({
      total_requests: 4,
      in_flight: 0,
      outcomes: { cancelled: 4 },
    })
  })
})

describe("fixed local resources", () => {
  test("copies only declared relative files as exact bytes, never executes a script, and reuses fixed cached content", async () => {
    await withDirectory(async (root) => {
      const bytes = encode("#!/bin/sh\r\nexit 97\r\n")
      mkdirSync(join(root, "scripts"))
      writeFileSync(join(root, "scripts", "check.sh"), bytes)
      writeFileSync(join(root, "undeclared-secret"), "never read")
      const source = localSource(manifest(file("scripts/check.sh", bytes)))
      const f = fixture()
      const options = { scope, bindings: [localBinding(root)] }
      const cold = await f.run(materializeFixedLocalFiles(source, options))
      expect(cold).toEqual([{ path: "scripts/check.sh", sha256: digest(bytes), bytes }])
      writeFileSync(join(root, "scripts", "check.sh"), "new unpinned content")
      expect(await f.run(materializeFixedLocalFiles(source, options))).toEqual(cold)
      expect(f.objects.size).toBe(1)
      expect(f.requests).toHaveLength(0)
      const restrictionKey = `content-restrictions/local/${digest(bytes)}.json`
      expect(f.json.get(restrictionKey)).toEqual({
        version: 1,
        sha256: digest(bytes),
        reason: "local_resource",
      })
      expect(f.writes.indexOf(restrictionKey)).toBeLessThan(
        f.writes.indexOf(`objects/${digest(bytes)}`),
      )
      expect(f.writes.filter((key) => key === restrictionKey)).toHaveLength(1)
    })
  })

  test.each(["machine_scope", "workspace_scope"] as const)(
    "rejects a different %s even when the content hash is already cached",
    async (field) => {
      const bytes = encode("fixed")
      const f = fixture()
      f.objects.set(`objects/${digest(bytes)}`, bytes)
      const source = localSource(manifest(file("asset", bytes)))
      const error = await f.run(
        Effect.flip(
          materializeFixedLocalFiles(source, {
            scope: { ...scope, [field]: "other" },
            bindings: [localBinding("/controlled")],
          }),
        ),
      )
      expect(error.code).toBe("LOCAL_RESOURCE_SCOPE_MISMATCH")
      expect(f.writes).toHaveLength(0)
    },
  )

  test("does not fall back to a same-name binding from another workspace or an ambiguous exact binding", async () => {
    const source = localSource(manifest(file("asset", encode("fixed"))))
    const f = fixture()
    expect(
      (
        await f.run(
          Effect.flip(
            materializeFixedLocalFiles(source, {
              scope,
              bindings: [{ ...localBinding("/controlled"), workspace_scope: "other" }],
            }),
          ),
        )
      ).code,
    ).toBe("LOCAL_RESOURCE_BINDING_MISSING")
    expect(
      (
        await f.run(
          Effect.flip(
            materializeFixedLocalFiles(source, {
              scope,
              bindings: [localBinding("/first"), localBinding("/second")],
            }),
          ),
        )
      ).code,
    ).toBe("LOCAL_RESOURCE_BINDING_AMBIGUOUS")
  })

  test("refuses an absolute path embedded in a shared local descriptor", async () => {
    const source = {
      ...localSource(manifest(file("asset", encode("fixed")))),
      absolute_root: "/private/shared-secret",
    }
    const f = fixture()
    const error = await f.run(
      Effect.flip(
        materializeFixedLocalFiles(source, { scope, bindings: [localBinding("/controlled")] }),
      ),
    )
    expect(error.code).toBe("INVALID_LOCAL_RESOURCE")
    expect(JSON.stringify(error)).not.toContain("/private/shared-secret")
    expect(f.writes).toHaveLength(0)
  })

  test("marks already cached bytes on a valid local read and refuses to return them if restriction persistence fails", async () => {
    const bytes = encode("previously cached")
    const source = localSource(manifest(file("asset", bytes)))
    const options = { scope, bindings: [localBinding("/controlled")] }
    const f = fixture()
    f.objects.set(`objects/${digest(bytes)}`, bytes)
    const failing: Store["Service"] = {
      ...f.store,
      writeJson: () =>
        Effect.fail(fail("STORAGE_ERROR", "Controlled restriction persistence failure.")),
    }
    const error = await f.run(
      Effect.flip(
        materializeFixedLocalFiles(source, options).pipe(Effect.provideService(Store, failing)),
      ),
    )
    expect(error.code).toBe("STORAGE_ERROR")
    expect(f.json.size).toBe(0)
    expect(await f.run(materializeFixedLocalFiles(source, options))).toEqual([
      { path: "asset", sha256: digest(bytes), bytes },
    ])
    expect(f.json.get(`content-restrictions/local/${digest(bytes)}.json`)).toEqual({
      version: 1,
      sha256: digest(bytes),
      reason: "local_resource",
    })
    expect(f.requests).toHaveLength(0)
  })

  test("does not publish newly verified local bytes if their durable restriction cannot be written", async () => {
    await withDirectory(async (root) => {
      const bytes = encode("new private bytes")
      writeFileSync(join(root, "asset"), bytes)
      const f = fixture()
      const failing: Store["Service"] = {
        ...f.store,
        writeJson: () =>
          Effect.fail(fail("STORAGE_ERROR", "Controlled restriction persistence failure.")),
      }
      const error = await f.run(
        Effect.flip(
          materializeFixedLocalFiles(localSource(manifest(file("asset", bytes))), {
            scope,
            bindings: [localBinding(root)],
          }).pipe(Effect.provideService(Store, failing)),
        ),
      )
      expect(error.code).toBe("STORAGE_ERROR")
      expect(f.objects.size).toBe(0)
      expect(f.json.size).toBe(0)
      expect(f.writes).toHaveLength(0)
    })
  })

  test.each(["leaf", "parent", "root"])(
    "rejects a symlink at the %s before reading outside the bound directory",
    async (where) => {
      await withDirectory(async (root) => {
        const outside = join(root, "outside")
        const selected = join(root, "selected")
        mkdirSync(outside)
        mkdirSync(selected)
        const bytes = encode("fixed")
        writeFileSync(join(outside, "asset"), bytes)
        let absoluteRoot = selected
        let path = "asset"
        if (where === "leaf") symlinkSync(join(outside, "asset"), join(selected, "asset"))
        else if (where === "parent") {
          symlinkSync(outside, join(selected, "linked"))
          path = "linked/asset"
        } else {
          absoluteRoot = join(root, "root-link")
          symlinkSync(outside, absoluteRoot)
        }
        const f = fixture()
        const error = await f.run(
          Effect.flip(
            materializeFixedLocalFiles(localSource(manifest(file(path, bytes))), {
              scope,
              bindings: [localBinding(absoluteRoot)],
            }),
          ),
        )
        expect(error.code).toBe("LOCAL_RESOURCE_SYMLINK_REFUSED")
        expect(f.objects.size).toBe(0)
      })
    },
  )

  test("refuses a directory or same-length changed local bytes", async () => {
    await withDirectory(async (root) => {
      const bytes = encode("fixed")
      mkdirSync(join(root, "directory"))
      writeFileSync(join(root, "changed"), "bad!!")
      for (const path of ["directory", "changed"]) {
        const f = fixture()
        const error = await f.run(
          Effect.flip(
            materializeFixedLocalFiles(localSource(manifest(file(path, bytes))), {
              scope,
              bindings: [localBinding(root)],
            }),
          ),
        )
        expect(error.code).toBe(
          path === "directory" ? "LOCAL_RESOURCE_NOT_REGULAR_FILE" : "FIXED_RESOURCE_HASH_MISMATCH",
        )
        expect(f.objects.size).toBe(0)
        expect(f.json.size).toBe(0)
      }
    })
  })

  test("checks path identity against the opened descriptor before reading a replaced name", async () => {
    await withDirectory(async (root) => {
      const bytes = encode("fixed")
      const target = join(root, "asset")
      writeFileSync(target, bytes)
      const f = fixture()
      const error = await f.run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const controlled: FileSystem.FileSystem = {
            ...fs,
            open: (path, options) =>
              fs.open(path, options).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    if (path === target) {
                      renameSync(target, `${target}.old`)
                      writeFileSync(target, bytes)
                    }
                  }),
                ),
              ),
          }
          return yield* Effect.flip(
            materializeFixedLocalFiles(localSource(manifest(file("asset", bytes))), {
              scope,
              bindings: [localBinding(root)],
            }),
          ).pipe(Effect.provideService(FileSystem.FileSystem, controlled))
        }),
      )
      expect(error.code).toBe("LOCAL_RESOURCE_CHANGED")
      expect(f.objects.size).toBe(0)
    })
  })

  test("cancels an in-progress descriptor read and closes its scope without writing an object", async () => {
    await withDirectory(async (root) => {
      const bytes = encode("fixed")
      writeFileSync(join(root, "asset"), bytes)
      const f = fixture()
      const reading = Latch.makeUnsafe()
      let closed = 0
      await f.run(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem
            const controlled: FileSystem.FileSystem = {
              ...fs,
              open: (path, options) =>
                fs.open(path, options).pipe(
                  Effect.tap(() =>
                    Effect.addFinalizer(() =>
                      Effect.sync(() => {
                        closed++
                      }),
                    ),
                  ),
                  Effect.map(
                    (handle) =>
                      new Proxy(handle, {
                        get: (target, key) =>
                          key === "read"
                            ? () =>
                                Effect.sync(() => reading.openUnsafe()).pipe(
                                  Effect.andThen(Effect.never),
                                )
                            : Reflect.get(target, key, target),
                      }),
                  ),
                ),
            }
            const running = yield* Effect.forkChild(
              materializeFixedLocalFiles(localSource(manifest(file("asset", bytes))), {
                scope,
                bindings: [localBinding(root)],
              }).pipe(Effect.provideService(FileSystem.FileSystem, controlled)),
            )
            yield* reading.await
            yield* Fiber.interrupt(running)
          }),
        ),
      )
      expect(closed).toBe(1)
      expect(f.objects.size).toBe(0)
    })
  })
})
