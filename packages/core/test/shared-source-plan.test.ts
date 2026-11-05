import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Crypto, Effect, Fiber, FileSystem, Latch, Path, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { fail, SkillsError } from "../src/model.ts"
import { createRequestMetrics } from "../src/request-metrics.ts"
import { fixedFileManifestId, type FixedFileManifest } from "../src/shared-fixed-resources.ts"
import type { FixedGithubSource } from "../src/shared-github-source.ts"
import {
  inspectSharedSourcePlan,
  materializeSharedSourcePlan,
  sharedSourcePlanId,
  type SharedSourcePlan,
  type SharedSourcePlanOptions,
  type SourcePlanResource,
} from "../src/shared-source-plan.ts"
import { Store } from "../src/store.ts"
import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"

const encode = (value: string) => new TextEncoder().encode(value)
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const gitOid = (bytes: Uint8Array) =>
  createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex")
const fixedFile = (path: string, bytes: Uint8Array) => ({
  path,
  sha256: digest(bytes),
  bytes: bytes.byteLength,
})
const fixedManifest = (...files: FixedFileManifest["files"]): FixedFileManifest => ({
  version: 1,
  files,
})
const origin = "https://raw.githubusercontent.com"
const httpUrl = `${origin}/example/resources/fixed/asset`
const localScope = { machine_scope: "machine-a", workspace_scope: "workspace-a" }
const httpResource = (
  path: string,
  bytes: Uint8Array,
  url = httpUrl,
): Extract<SourcePlanResource, { kind: "http" }> => ({
  kind: "http",
  manifest: fixedManifest(fixedFile(path, bytes)),
  locations: [{ sha256: digest(bytes), url }],
})
const localResource = (
  path: string,
  bytes: Uint8Array,
): Extract<SourcePlanResource, { kind: "local" }> => ({
  kind: "local",
  binding_key: "private-assets",
  ...localScope,
  manifest: fixedManifest(fixedFile(path, bytes)),
})
const localOptions = (absoluteRoot: string): NonNullable<SharedSourcePlanOptions["local"]> => ({
  scope: localScope,
  bindings: [{ binding_key: "private-assets", ...localScope, absolute_root: absoluteRoot }],
})
const sourcePlan = (
  base: SourcePlanResource | null,
  mounts: SharedSourcePlan["mounts"] = [],
): SharedSourcePlan => ({
  version: 1,
  kind: "composition",
  base,
  mounts,
})
const gitSource = (path: string, bytes: Uint8Array): FixedGithubSource => ({
  url: "https://github.com/example/resources",
  commit: "1".repeat(40),
  tree: "2".repeat(40),
  root: "fixed",
  files: [{ path, source_path: `fixed/${path}`, git_oid: gitOid(bytes), bytes: bytes.byteLength }],
})
const gitUrl = (source: FixedGithubSource, sourcePath: string) =>
  `${origin}/example/resources/${source.commit}/${sourcePath}`

type Requirements =
  | Store
  | Crypto.Crypto
  | HttpClient.HttpClient
  | FileSystem.FileSystem
  | Path.Path

function fixture(bodies: ReadonlyMap<string, Uint8Array> = new Map(), delay = false) {
  const objects = new Map<string, Uint8Array>()
  const json = new Map<string, unknown>()
  const requests: string[] = []
  const writes: string[] = []
  const objectReads: string[] = []
  const jsonReads: string[] = []
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
          jsonReads.push(key)
          return json.has(key) ? Schema.decodeUnknownSync(schema)(json.get(key)) : undefined
        },
        catch: () => fail("STATE_CORRUPT", "Controlled derived cache corruption."),
      }),
    writeJson: (key, value) =>
      Effect.sync(() => {
        json.set(key, structuredClone(value))
        writes.push(key)
      }),
    readBytes: (key) =>
      Effect.gen(function* () {
        objectReads.push(key)
        const bytes = objects.get(key)
        return bytes === undefined
          ? yield* Effect.fail(fail("SNAPSHOT_MISSING", "Controlled missing object."))
          : bytes.slice()
      }),
    writeBytes: (key, bytes) =>
      Effect.sync(() => {
        objects.set(key, bytes.slice())
        writes.push(key)
      }),
  }
  const client = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      requests.push(url.toString())
      if (delay) yield* Effect.sleep("5 millis")
      const bytes = bodies.get(url.toString())
      return HttpClientResponse.fromWeb(
        request,
        bytes === undefined
          ? new Response(null, { status: 404 })
          : new Response(bytes.slice(), {
              headers: { "content-length": String(bytes.byteLength) },
            }),
      )
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
  return { objects, json, requests, writes, objectReads, jsonReads, metrics, run, store }
}

function guardLocalReads<A, E>(effect: Effect.Effect<A, E, Requirements>, reads: string[]) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const refused = (operation: string, path: string) => {
      reads.push(`${operation}:${path}`)
      return Effect.die(new Error("Excluded local content must not be read."))
    }
    return yield* effect.pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        realPath: (path) => refused("realPath", path),
        stat: (path) => refused("stat", path),
        open: (path) => refused("open", path),
      }),
    )
  })
}

describe("privacy publication", () => {
  for (const kind of ["http", "git"] as const) {
    const resource = (
      files: readonly { readonly path: string; readonly bytes: Uint8Array }[],
    ): SourcePlanResource => {
      if (kind === "git") {
        const source = gitSource(files[0]!.path, files[0]!.bytes)
        return {
          kind,
          source: {
            ...source,
            files: files.map((file) => gitSource(file.path, file.bytes).files[0]!),
          },
        }
      }
      return {
        kind,
        manifest: fixedManifest(...files.map((file) => fixedFile(file.path, file.bytes))),
        locations: files.map((file) => ({
          sha256: digest(file.bytes),
          url: `${httpUrl}/${file.path}`,
        })),
      }
    }
    const urlFor = (path: string) =>
      kind === "http"
        ? `${httpUrl}/${path}`
        : gitUrl(gitSource(path, encode("identity not used for URL")), `fixed/${path}`)
    const options = { local: localOptions("/controlled/missing-local-root") }

    test(`${kind} preserves a published local alias when a concurrent required object fails`, async () => {
      const bytes = encode("verified private alias\n"),
        required = encode("unavailable required body\n")
      const hash = digest(bytes),
        object = `objects/${hash}`
      const marker = `content-restrictions/local/${hash}.json`
      const published = Latch.makeUnsafe(),
        calls: string[] = [],
        localReads: string[] = []
      const f = fixture()
      const client = HttpClient.make((request, url) =>
        Effect.gen(function* () {
          calls.push(url.toString())
          if (url.toString() === urlFor("public.txt"))
            return HttpClientResponse.fromWeb(
              request,
              new Response(bytes.slice(), {
                headers: { "content-length": String(bytes.length) },
              }),
            )
          expect(url.toString()).toBe(urlFor("required.txt"))
          yield* published.await
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 404 }))
        }),
      )
      const plan = sourcePlan(
        resource([
          { path: "public.txt", bytes },
          { path: "required.txt", bytes: required },
        ]),
        [{ mount_path: "private", resource: localResource("excluded.txt", bytes) }],
      )
      const effect = materializeSharedSourcePlan(plan, options, [
        "public.txt",
        "required.txt",
      ]).pipe(
        Effect.provideService(Store, {
          ...f.store,
          writeBytes: (key, value) =>
            f.store.writeBytes(key, value).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (key === object) published.openUnsafe()
                }),
              ),
            ),
        }),
      )
      const error = await f.run(Effect.flip(guardLocalReads(effect, localReads)), client)
      expect(error.code).toBe(
        kind === "http" ? "HTTP_RESOURCE_UNAVAILABLE" : "GITHUB_PUBLIC_SOURCE_UNAVAILABLE",
      )
      expect(f.objects.get(object)).toEqual(bytes)
      expect(calls.sort()).toEqual([urlFor("public.txt"), urlFor("required.txt")].sort())
      expect(localReads).toEqual([])
      expect(f.json.get(marker)).toEqual({ version: 1, sha256: hash, reason: "local_resource" })
      expect(f.writes.indexOf(marker)).toBeLessThan(f.writes.indexOf(object))
      const mapping = f.writes.indexOf(`cache/shared-github-blobs/${gitOid(bytes)}.json`)
      if (mapping !== -1) expect(f.writes.indexOf(marker)).toBeLessThan(mapping)
      const reused = await f.run(
        materializeSharedSourcePlan(sourcePlan(httpResource("reused.txt", bytes))),
      )
      expect(reused.local_paths).toEqual(["reused.txt"])
      expect(f.requests).toEqual([])
      expect(f.json.has(`content-restrictions/local/${digest(required)}.json`)).toBe(false)
    })

    test(`${kind} classifies a verified cached alias before a later required resource fails`, async () => {
      const bytes = encode("previously public cached bytes\n"),
        required = encode("required\n")
      const base = resource([{ path: "public.txt", bytes }])
      const f = fixture(new Map([[urlFor("public.txt"), bytes]])),
        localReads: string[] = []
      await f.run(materializeSharedSourcePlan(sourcePlan(base)))
      const marker = `content-restrictions/local/${digest(bytes)}.json`
      expect(f.json.has(marker)).toBe(false)
      const plan = sourcePlan(base, [
        { mount_path: "private", resource: localResource("excluded.txt", bytes) },
        {
          mount_path: "required",
          resource: httpResource("missing.txt", required, `${httpUrl}/missing`),
        },
      ])
      const error = await f.run(
        Effect.flip(
          guardLocalReads(
            materializeSharedSourcePlan(plan, options, ["public.txt", "required/missing.txt"]),
            localReads,
          ),
        ),
      )
      expect(error.code).toBe("HTTP_RESOURCE_UNAVAILABLE")
      expect(localReads).toEqual([])
      expect(f.json.get(marker)).toEqual({
        version: 1,
        sha256: digest(bytes),
        reason: "local_resource",
      })
      const requests = [...f.requests]
      expect(requests).toEqual([urlFor("public.txt"), `${httpUrl}/missing`])
      const reused = await f.run(
        materializeSharedSourcePlan(sourcePlan(httpResource("reused.txt", bytes))),
      )
      expect(reused.local_paths).toEqual(["reused.txt"])
      expect(f.requests).toEqual(requests)
    })

    test(`${kind} refuses object publication and cached return when the local alias marker cannot persist`, async () => {
      for (const cached of [false, true]) {
        const bytes = encode("private alias requiring durable classification\n")
        const base = resource([{ path: "public.txt", bytes }])
        const f = fixture(new Map([[urlFor("public.txt"), bytes]])),
          localReads: string[] = []
        if (cached) await f.run(materializeSharedSourcePlan(sourcePlan(base)))
        const beforeObjects = new Map(f.objects),
          beforeJson = new Map(f.json)
        const plan = sourcePlan(base, [
          { mount_path: "private", resource: localResource("excluded.txt", bytes) },
        ])
        const effect = materializeSharedSourcePlan(plan, options, ["public.txt"]).pipe(
          Effect.provideService(Store, {
            ...f.store,
            writeJson: (key, value) =>
              key.startsWith("content-restrictions/local/")
                ? Effect.fail(fail("STORAGE_ERROR", "Controlled restriction persistence failure."))
                : f.store.writeJson(key, value),
          }),
        )
        expect((await f.run(Effect.flip(guardLocalReads(effect, localReads)))).code).toBe(
          "STORAGE_ERROR",
        )
        expect(f.objects).toEqual(beforeObjects)
        expect(f.json).toEqual(beforeJson)
        expect(localReads).toEqual([])
      }
    })

    test(`${kind} leaves empty selections and corrupt alias bytes without a local marker`, async () => {
      const bytes = encode("private bytes require complete validation\n")
      const damaged = bytes.slice()
      damaged[0] = damaged[0]! ^ 1
      const base = resource([{ path: "public.txt", bytes }])
      const bodies = new Map([[urlFor("public.txt"), damaged]])
      const f = fixture(bodies),
        localReads: string[] = []
      const plan = sourcePlan(base, [
        { mount_path: "private", resource: localResource("excluded.txt", bytes) },
      ])
      const empty = await f.run(
        guardLocalReads(materializeSharedSourcePlan(plan, options, []), localReads),
      )
      expect(empty.files).toEqual([])
      expect(empty.local_paths).toEqual([])
      expect(f.requests).toEqual([])
      expect(f.writes).toEqual([])
      expect(
        (
          await f.run(
            Effect.flip(
              guardLocalReads(
                materializeSharedSourcePlan(plan, options, ["public.txt"]),
                localReads,
              ),
            ),
          )
        ).code,
      ).toBe(kind === "http" ? "FIXED_RESOURCE_HASH_MISMATCH" : "GITHUB_BLOB_MISMATCH")
      expect(f.objects.size).toBe(0)
      expect(f.json.size).toBe(0)
      bodies.set(urlFor("public.txt"), bytes)
      await f.run(materializeSharedSourcePlan(sourcePlan(base)))
      f.objects.set(`objects/${digest(bytes)}`, damaged)
      const requests = [...f.requests]
      expect(
        (
          await f.run(
            Effect.flip(
              guardLocalReads(
                materializeSharedSourcePlan(plan, options, ["public.txt"]),
                localReads,
              ),
            ),
          )
        ).code,
      ).toBe(kind === "http" ? "FIXED_RESOURCE_CACHE_CORRUPT" : "SOURCE_CACHE_CORRUPT")
      expect(f.requests).toEqual(requests)
      expect(f.json.has(`content-restrictions/local/${digest(bytes)}.json`)).toBe(false)
      expect(localReads).toEqual([])
    })
  }
})

describe("selective source plan", () => {
  test("restricts a verified HTTP alias of excluded local content without reading local bytes", async () => {
    const bytes = encode("same declared local content\n"),
      unrelated = encode("unselected private content\n")
    const local = {
      ...localResource("missing.bin", bytes),
      manifest: fixedManifest(
        fixedFile("missing.bin", bytes),
        fixedFile("unrelated.bin", unrelated),
      ),
    }
    const plan = sourcePlan(httpResource("public.txt", bytes), [
      { mount_path: "private", resource: local },
    ])
    const options = { local: localOptions("/controlled/missing-local-root") }
    const f = fixture(new Map([[httpUrl, bytes]])),
      localReads: string[] = []
    const run = (source: SharedSourcePlan, paths: readonly string[]) =>
      f.run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const controlled: FileSystem.FileSystem = {
            ...fs,
            realPath: (path) => {
              localReads.push(`realPath:${path}`)
              return Effect.die(new Error("Excluded local content must not be read."))
            },
            open: (path) => {
              localReads.push(`open:${path}`)
              return Effect.die(new Error("Excluded local content must not be opened."))
            },
          }
          return yield* materializeSharedSourcePlan(source, options, paths).pipe(
            Effect.provideService(FileSystem.FileSystem, controlled),
          )
        }),
      )
    expect(inspectSharedSourcePlan(plan).local_paths).toEqual([
      "private/missing.bin",
      "private/unrelated.bin",
      "public.txt",
    ])
    expect(f.json.size).toBe(0)
    expect((await run(plan, [])).local_paths).toEqual([])
    expect(f.writes).toEqual([])
    expect(f.objectReads).toEqual([])
    const selected = await run(plan, ["public.txt"])
    expect(selected.files).toEqual([{ path: "public.txt", bytes }])
    expect(selected.local_paths).toEqual(["public.txt"])
    expect(f.requests).toEqual([httpUrl])
    expect(f.objectReads).toEqual([`objects/${digest(bytes)}`])
    expect(localReads).toEqual([])
    const restriction = `content-restrictions/local/${digest(bytes)}.json`
    expect(f.json.get(restriction)).toEqual({
      version: 1,
      sha256: digest(bytes),
      reason: "local_resource",
    })
    expect(f.json.has(`content-restrictions/local/${digest(unrelated)}.json`)).toBe(false)
    const publicOnly = sourcePlan(httpResource("renamed.txt", bytes))
    expect((await run(publicOnly, ["renamed.txt"])).local_paths).toEqual(["renamed.txt"])
    expect(f.requests).toHaveLength(1)
    f.objects.clear()
    expect((await run(publicOnly, ["renamed.txt"])).local_paths).toEqual(["renamed.txt"])
    expect(f.requests).toEqual([httpUrl, httpUrl])
    expect(f.writes.filter((key) => key === restriction)).toHaveLength(1)
    expect(localReads).toEqual([])
  })

  test("never persists a local alias restriction from metadata or unverified selected HTTP bytes", async () => {
    const bytes = encode("fixed local content\n")
    const plan = sourcePlan(httpResource("public.txt", bytes), [
      { mount_path: "private", resource: localResource("missing.bin", bytes) },
    ])
    const f = fixture(new Map([[httpUrl, new Uint8Array(bytes.length)]]))
    expect(inspectSharedSourcePlan(plan).local_paths).toEqual(["private/missing.bin", "public.txt"])
    const error = await f.run(
      Effect.flip(
        materializeSharedSourcePlan(
          plan,
          { local: localOptions("/controlled/missing-local-root") },
          ["public.txt"],
        ),
      ),
    )
    expect(error.code).toBe("FIXED_RESOURCE_HASH_MISMATCH")
    expect(f.json.size).toBe(0)
    expect(f.objects.size).toBe(0)
    expect(f.writes).toEqual([])
  })

  test("rejects conflicting identities across excluded resources before any bytes", async () => {
    const bytes = encode("fixed\n"),
      git = gitSource("SKILL.md", bytes)
    const first = git.files[0]!
    const gitConflict = sourcePlan({ kind: "git", source: git }, [
      {
        mount_path: "unused",
        resource: {
          kind: "git",
          source: {
            ...git,
            files: [{ ...first, bytes: first.bytes + 1 }],
          },
        },
      },
    ])
    const http = httpResource("SKILL.md", bytes)
    const httpConflict = sourcePlan(http, [
      {
        mount_path: "unused",
        resource: {
          ...http,
          manifest: fixedManifest({ ...http.manifest.files[0]!, bytes: bytes.length + 1 }),
        },
      },
    ])
    for (const plan of [gitConflict, httpConflict]) {
      const f = fixture()
      expect(
        (await f.run(Effect.flip(materializeSharedSourcePlan(plan, {}, ["SKILL.md"])))).code,
      ).toBe("INVALID_SOURCE_PLAN")
      expect(f.objectReads).toEqual([])
      expect(f.jsonReads).toEqual([])
      expect(f.requests).toEqual([])
    }
  })

  test("keeps full identities and runtime manifest lookup while acquiring only effective mounted paths", async () => {
    const main = encode("# Fixed main\n"),
      unusedGit = encode("excluded git\n")
    const icon = new Uint8Array([0, 255, 13, 10]),
      unusedHttp = encode("excluded http\n")
    const local = encode("excluded local\n")
    const git = gitSource("SKILL.md", main)
    const excludedGit = gitSource("unused.txt", unusedGit).files[0]!
    const source = { ...git, files: [...git.files, excludedGit] }
    const http: Extract<SourcePlanResource, { kind: "http" }> = {
      kind: "http",
      manifest: fixedManifest(fixedFile("icon.bin", icon), fixedFile("unused.bin", unusedHttp)),
      locations: [
        { sha256: digest(icon), url: `${httpUrl}/icon` },
        { sha256: digest(unusedHttp), url: `${httpUrl}/unused` },
      ],
    }
    const plan = sourcePlan({ kind: "git", source }, [
      { mount_path: "assets", resource: http },
      { mount_path: "private", resource: localResource("missing.bin", local) },
    ])
    const signed = `${httpUrl}/runtime?signature=machine-only`
    const f = fixture(
      new Map([
        [gitUrl(source, "fixed/SKILL.md"), main],
        [signed, icon],
      ]),
    )
    const id = await f.run(fixedFileManifestId(http.manifest))
    const options: SharedSourcePlanOptions = {
      http: {
        locationsByManifest: {
          [id]: [
            { sha256: digest(icon), url: signed },
            { sha256: digest(unusedHttp), url: `${httpUrl}/unused-runtime` },
          ],
        },
      },
      local: localOptions("/controlled/private"),
    }
    const inspection = inspectSharedSourcePlan(plan)
    expect(inspection.paths).toEqual([
      "SKILL.md",
      "assets/icon.bin",
      "assets/unused.bin",
      "private/missing.bin",
      "unused.txt",
    ])
    expect(inspection.local_paths).toEqual(["private/missing.bin"])
    expect(inspection.manifest.find((file) => file.path === "SKILL.md")).toEqual({
      path: "SKILL.md",
      bytes: main.length,
      identity: { kind: "git", git_oid: gitOid(main) },
    })
    expect(inspection.manifest.find((file) => file.path === "private/missing.bin")).toEqual({
      path: "private/missing.bin",
      bytes: local.length,
      identity: { kind: "sha256", sha256: digest(local) },
    })
    f.json.set(`cache/shared-github-blobs/${gitOid(unusedGit)}.json`, { version: "corrupt unused" })
    f.objects.set(`objects/${digest(unusedHttp)}`, new Uint8Array(unusedHttp.length))
    const selected = ["assets/icon.bin", "SKILL.md"]
    const cold = await f.run(materializeSharedSourcePlan(plan, options, selected))
    expect(cold.source_plan_id).toBe(await f.run(sharedSourcePlanId(plan)))
    expect(cold.paths).toEqual(inspection.paths)
    expect(cold.files).toEqual([
      { path: "SKILL.md", bytes: main },
      { path: "assets/icon.bin", bytes: icon },
    ])
    expect(cold.local_paths).toEqual([])
    expect(f.requests).toEqual([gitUrl(source, "fixed/SKILL.md"), signed])
    expect(f.objectReads).toEqual([`objects/${digest(icon)}`])
    expect(f.jsonReads).not.toContain(`cache/shared-github-blobs/${gitOid(unusedGit)}.json`)
    expect(await f.run(materializeSharedSourcePlan(plan, options, selected))).toEqual(cold)
    expect(f.requests).toHaveLength(2)
    expect(inspectSharedSourcePlan(plan).manifest).toEqual(inspection.manifest)
    f.objectReads.length = 0
    f.jsonReads.length = 0
    const empty = await f.run(materializeSharedSourcePlan(plan, options, []))
    expect(empty).toEqual({
      source_plan_id: cold.source_plan_id,
      paths: inspection.paths,
      files: [],
      local_paths: [],
    })
    expect(f.objectReads).toEqual([])
    expect(f.jsonReads).toEqual([])
    expect(f.requests).toHaveLength(2)
  })

  test("admits excluded HTTP and local resources before reading any selected base object", async () => {
    const main = encode("# main\n"),
      unused = encode("unused\n")
    const source = gitSource("SKILL.md", main)
    const base = { kind: "git" as const, source }
    const http = httpResource("unused.bin", unused, "https://untrusted.example.com/asset")
    const local = localResource("unused.bin", unused)
    const cases = [
      {
        plan: sourcePlan(base, [{ mount_path: "http", resource: http }]),
        options: {},
        code: "HTTP_RESOURCE_ORIGIN_NOT_ALLOWED",
      },
      {
        plan: sourcePlan(base, [{ mount_path: "local", resource: local }]),
        options: {},
        code: "SOURCE_PLAN_LOCAL_BINDING_REQUIRED",
      },
      {
        plan: sourcePlan(base, [{ mount_path: "local", resource: local }]),
        options: {
          local: {
            ...localOptions("/controlled/private"),
            scope: { ...localScope, machine_scope: "different" },
          },
        },
        code: "LOCAL_RESOURCE_SCOPE_MISMATCH",
      },
    ]
    for (const scenario of cases) {
      const f = fixture(new Map([[gitUrl(source, "fixed/SKILL.md"), main]]))
      const result = await f.run(
        Effect.flip(materializeSharedSourcePlan(scenario.plan, scenario.options, ["SKILL.md"])),
      )
      expect(result.code).toBe(scenario.code)
      expect(f.requests).toEqual([])
      expect(f.objectReads).toEqual([])
      expect(f.jsonReads).toEqual([])
      expect(f.writes).toEqual([])
    }
  })

  test("refuses excluded invalid metadata and incomplete full-manifest runtime locations", async () => {
    const first = encode("one"),
      unused = encode("unused")
    const resource: Extract<SourcePlanResource, { kind: "http" }> = {
      kind: "http",
      manifest: fixedManifest(fixedFile("one.bin", first), fixedFile("unused.bin", unused)),
      locations: [
        { sha256: digest(first), url: httpUrl },
        { sha256: digest(unused), url: `${httpUrl}/unused` },
      ],
    }
    const plan = sourcePlan(resource),
      f = fixture()
    const id = await f.run(fixedFileManifestId(resource.manifest))
    expect(
      (
        await f.run(
          materializeSharedSourcePlan(
            plan,
            {
              http: { locationsByManifest: { [id]: [resource.locations[0]!] } },
            },
            ["one.bin"],
          ).pipe(Effect.result),
        )
      )._tag,
    ).toBe("Failure")
    const invalid = sourcePlan({
      ...resource,
      manifest: fixedManifest(fixedFile("one.bin", first), fixedFile("../hidden", unused)),
    })
    expect(
      (await f.run(materializeSharedSourcePlan(invalid, {}, ["one.bin"]).pipe(Effect.result)))._tag,
    ).toBe("Failure")
    for (const paths of [["absent"], ["one.bin", "one.bin"]])
      expect((await f.run(Effect.flip(materializeSharedSourcePlan(plan, {}, paths)))).code).toBe(
        "FILE_NOT_FOUND",
      )
    expect(f.requests).toEqual([])
    expect(f.objectReads).toEqual([])
    expect(f.writes).toEqual([])
  })
})

async function withDirectory<A>(use: (root: string) => Promise<A>): Promise<A> {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ntn-source-plan-"))
  try {
    return await use(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe("fixed shared source plan identity and preflight", () => {
  test("canonicalizes mounts and returns deterministic declared paths before any I/O", async () => {
    const one = httpResource("one.txt", encode("one"))
    const two = httpResource("two.txt", encode("two"))
    const plan = sourcePlan(null, [
      { mount_path: "z", resource: one },
      { mount_path: "a", resource: two },
    ])
    const inspection = inspectSharedSourcePlan(plan)
    expect(inspection.paths).toEqual(["a/two.txt", "z/one.txt"])
    expect(inspection.local_paths).toEqual([])
    expect(inspection.plan.mounts.map((mount) => mount.mount_path)).toEqual(["a", "z"])
    const f = fixture()
    const first = await f.run(sharedSourcePlanId(plan))
    expect(first).toMatch(/^source-plan-[a-f0-9]{64}$/)
    expect(await f.run(sharedSourcePlanId({ ...plan, mounts: [...plan.mounts].reverse() }))).toBe(
      first,
    )
    expect(
      await f.run(sharedSourcePlanId(sourcePlan(null, [{ mount_path: "other", resource: one }]))),
    ).not.toBe(first)
    expect(f.requests).toHaveLength(0)
  })

  test("allows a native-body-only empty source tree without inventing an entrypoint", async () => {
    const f = fixture()
    const plan = sourcePlan(null)
    expect(inspectSharedSourcePlan(plan).paths).toEqual([])
    expect(await f.run(materializeSharedSourcePlan(plan))).toEqual({
      source_plan_id: await f.run(sharedSourcePlanId(plan)),
      paths: [],
      local_paths: [],
      files: [],
    })
    expect(f.requests).toHaveLength(0)
    expect(f.writes).toHaveLength(0)
  })

  const collisions = [
    sourcePlan(httpResource("same", encode("a")), [
      { mount_path: "", resource: httpResource("same", encode("b")) },
    ]),
    sourcePlan(null, [
      { mount_path: "docs", resource: httpResource("same", encode("a")) },
      { mount_path: "docs", resource: httpResource("same", encode("b")) },
    ]),
    sourcePlan(httpResource("Dir/a", encode("a")), [
      { mount_path: "dir", resource: httpResource("b", encode("b")) },
    ]),
    sourcePlan(httpResource("é.txt", encode("a")), [
      { mount_path: "", resource: httpResource("é.txt", encode("b")) },
    ]),
    sourcePlan(httpResource("dir", encode("a")), [
      { mount_path: "dir", resource: httpResource("child", encode("b")) },
    ]),
    sourcePlan(null, [{ mount_path: "../outside", resource: httpResource("child", encode("a")) }]),
    sourcePlan(null, [{ mount_path: "./docs", resource: httpResource("child", encode("a")) }]),
  ]
  test.each(collisions)(
    "refuses complete-tree conflicts or traversal before provider I/O",
    async (plan) => {
      const f = fixture()
      const error = await f.run(Effect.flip(materializeSharedSourcePlan(plan)))
      expect(error).toBeInstanceOf(SkillsError)
      expect(f.requests).toHaveLength(0)
      expect(f.writes).toHaveLength(0)
    },
  )

  test("checks empty mounts too and rejects policy or absolute paths embedded in shared payload", () => {
    const empty: SourcePlanResource = { kind: "http", manifest: fixedManifest(), locations: [] }
    expect(
      inspectSharedSourcePlan(sourcePlan(null, [{ mount_path: "docs", resource: empty }])).paths,
    ).toEqual([])
    expect(() =>
      inspectSharedSourcePlan(sourcePlan(null, [{ mount_path: "../outside", resource: empty }])),
    ).toThrow()
    expect(() =>
      inspectSharedSourcePlan({ ...sourcePlan(null), allowedOrigins: ["https://private.example"] }),
    ).toThrow()
    const embeddedPath = { ...localResource("file", encode("x")), absolute_root: "/private" }
    expect(() => inspectSharedSourcePlan({ ...sourcePlan(null), base: embeddedPath })).toThrow()
    expect(() =>
      inspectSharedSourcePlan({
        ...sourcePlan(null),
        base: { kind: "notion", page_id: "anything" },
      }),
    ).toThrow()
  })

  test("binds a new fixed Git revision to a new plan ID without branch or tree discovery", async () => {
    const bytes = encode("fixed\r\n")
    const source = gitSource("asset", bytes)
    const f = fixture(new Map([[gitUrl(source, "fixed/asset"), bytes]]))
    const firstPlan = sourcePlan({ kind: "git", source })
    const secondPlan = sourcePlan({
      kind: "git",
      source: { ...source, commit: "3".repeat(40), tree: "4".repeat(40) },
    })
    const first = await f.run(materializeSharedSourcePlan(firstPlan, { metrics: f.metrics }))
    const second = await f.run(materializeSharedSourcePlan(secondPlan, { metrics: f.metrics }))
    expect(second.source_plan_id).not.toBe(first.source_plan_id)
    expect(second.files).toEqual(first.files)
    expect(f.requests).toEqual([gitUrl(source, "fixed/asset")])
    expect(f.requests.every((url) => url.startsWith(origin))).toBe(true)
  })
})

describe("fixed multi-source materialization", () => {
  test("combines exact Git, HTTP, and scoped local bytes, records local output paths, and has a provider-free warm run", async () => {
    await withDirectory(async (root) => {
      const gitBytes = encode("#!/bin/sh\r\nexit 93\r\n")
      const httpBytes = new Uint8Array([255, 0, 13, 10])
      const privateBytes = encode("private local content\n")
      writeFileSync(join(root, "input.bin"), privateBytes)
      const git = gitSource("scripts/check.sh", gitBytes)
      const plan = sourcePlan({ kind: "git", source: git }, [
        { mount_path: "resources", resource: httpResource("asset.bin", httpBytes) },
        { mount_path: "private", resource: localResource("input.bin", privateBytes) },
      ])
      const f = fixture(
        new Map([
          [gitUrl(git, "fixed/scripts/check.sh"), gitBytes],
          [httpUrl, httpBytes],
        ]),
      )
      const options = { local: localOptions(root), metrics: f.metrics }
      const cold = await f.run(materializeSharedSourcePlan(plan, options))
      expect(cold.paths).toEqual(["private/input.bin", "resources/asset.bin", "scripts/check.sh"])
      expect(cold.files).toEqual([
        { path: "private/input.bin", bytes: privateBytes },
        { path: "resources/asset.bin", bytes: httpBytes },
        { path: "scripts/check.sh", bytes: gitBytes },
      ])
      expect(cold.local_paths).toEqual(["private/input.bin"])
      expect(JSON.stringify(cold)).not.toContain(root)
      expect(JSON.stringify(cold)).not.toContain("https://")
      const before = f.metrics.snapshot()
      expect(await f.run(materializeSharedSourcePlan(plan, options))).toEqual(cold)
      expect(f.metrics.snapshot()).toEqual(before)
      expect(f.requests).toHaveLength(2)
      expect(before.provider_requests).toEqual({ github: 1, http: 1 })
      expect(
        f.writes.every(
          (key) =>
            key.startsWith("objects/") ||
            key.startsWith("cache/shared-github-blobs/") ||
            key.startsWith("content-restrictions/local/"),
        ),
      ).toBe(true)
    })
  })

  test("uses trusted runtime HTTP locations without changing the plan revision or clearing content objects", async () => {
    const bytes = encode("fixed object")
    const resource = httpResource("asset.bin", bytes)
    const plan = sourcePlan(resource)
    const authorized = "https://example.com/authorized.bin"
    const moved = "https://example.org/moved.bin"
    const f = fixture(new Map([[authorized, bytes]]))
    const manifestId = await f.run(fixedFileManifestId(resource.manifest))
    const cold = await f.run(
      materializeSharedSourcePlan(plan, {
        http: {
          allowedOrigins: ["https://example.com"],
          locationsByManifest: { [manifestId]: [{ sha256: digest(bytes), url: authorized }] },
        },
        metrics: f.metrics,
      }),
    )
    const warm = await f.run(
      materializeSharedSourcePlan(plan, {
        http: {
          allowedOrigins: ["https://example.org"],
          locationsByManifest: { [manifestId]: [{ sha256: digest(bytes), url: moved }] },
        },
        metrics: f.metrics,
      }),
    )
    expect(warm).toEqual(cold)
    expect(f.requests).toEqual([authorized])
    expect(f.objects.size).toBe(1)
    const error = await f.run(
      Effect.flip(
        materializeSharedSourcePlan(plan, {
          http: { locationsByManifest: { [manifestId]: [{ sha256: digest(bytes), url: moved }] } },
        }),
      ),
    )
    expect(error.code).toBe("HTTP_RESOURCE_ORIGIN_NOT_ALLOWED")
    expect(f.requests).toEqual([authorized])
    const relocatedPlan = sourcePlan({
      ...resource,
      locations: [{ sha256: digest(bytes), url: moved }],
    })
    expect(await f.run(sharedSourcePlanId(relocatedPlan))).not.toBe(cold.source_plan_id)
    expect(
      (
        await f.run(
          materializeSharedSourcePlan(relocatedPlan, {
            http: { allowedOrigins: ["https://example.org"] },
          }),
        )
      ).files,
    ).toEqual(cold.files)
    expect(f.requests).toEqual([authorized])
  })

  test("marks local provenance even when bytes are reused from a public resource with the same hash", async () => {
    await withDirectory(async (root) => {
      const bytes = encode("identical bytes")
      const plan = sourcePlan(httpResource("public.txt", bytes), [
        { mount_path: "local", resource: localResource("private.txt", bytes) },
      ])
      const f = fixture(new Map([[httpUrl, bytes]]))
      const result = await f.run(materializeSharedSourcePlan(plan, { local: localOptions(root) }))
      expect(result.local_paths).toEqual(["local/private.txt", "public.txt"])
      expect(result.files.map((entry) => entry.path)).toEqual(["local/private.txt", "public.txt"])
      expect(f.objects.size).toBe(1)
      expect(f.requests).toHaveLength(1)
      const wrongScope = {
        ...localOptions(root),
        scope: { ...localScope, workspace_scope: "other" },
      }
      expect(
        (await f.run(Effect.flip(materializeSharedSourcePlan(plan, { local: wrongScope })))).code,
      ).toBe("LOCAL_RESOURCE_SCOPE_MISMATCH")
    })
  })

  test("requires explicit machine local bindings and does not expose a partial tree after a later provider fails", async () => {
    const bytes = encode("fixed")
    const source = gitSource("base.txt", bytes)
    const f = fixture(new Map([[gitUrl(source, "fixed/base.txt"), bytes]]))
    const missingLocal = sourcePlan({ kind: "git", source }, [
      { mount_path: "local", resource: localResource("private", bytes) },
    ])
    expect((await f.run(Effect.flip(materializeSharedSourcePlan(missingLocal)))).code).toBe(
      "SOURCE_PLAN_LOCAL_BINDING_REQUIRED",
    )
    expect(f.requests).toHaveLength(0)
    const plan = sourcePlan({ kind: "git", source }, [
      { mount_path: "later", resource: httpResource("missing", encode("missing")) },
    ])
    expect((await f.run(Effect.flip(materializeSharedSourcePlan(plan)))).code).toBe(
      "HTTP_RESOURCE_UNAVAILABLE",
    )
    expect(f.requests).toEqual([gitUrl(source, "fixed/base.txt"), httpUrl])
    expect(f.writes.some((key) => key.startsWith("snapshots/") || key.startsWith("records/"))).toBe(
      false,
    )
  })

  test("an HTTP plan cannot clear a previous local restriction through a warm cache or a fresh download", async () => {
    await withDirectory(async (root) => {
      const bytes = encode("local bytes require separate archive permission")
      writeFileSync(join(root, "private.txt"), bytes)
      const bodies = new Map<string, Uint8Array>()
      const f = fixture(bodies)
      const localPlan = sourcePlan(localResource("private.txt", bytes))
      const local = await f.run(
        materializeSharedSourcePlan(localPlan, { local: localOptions(root) }),
      )
      expect(local.local_paths).toEqual(["private.txt"])
      const restrictionKey = `content-restrictions/local/${digest(bytes)}.json`
      const expected = { version: 1, sha256: digest(bytes), reason: "local_resource" }
      expect(f.json.get(restrictionKey)).toEqual(expected)
      const httpPlan = sourcePlan(httpResource("claimed-public.txt", bytes))
      const warm = await f.run(materializeSharedSourcePlan(httpPlan))
      expect(warm.local_paths).toEqual(["claimed-public.txt"])
      expect(f.requests).toHaveLength(0)
      f.objects.clear()
      bodies.set(httpUrl, bytes)
      const downloaded = await f.run(materializeSharedSourcePlan(httpPlan))
      expect(downloaded.files).toEqual(warm.files)
      expect(downloaded.local_paths).toEqual(["claimed-public.txt"])
      expect(f.requests).toEqual([httpUrl])
      expect(f.json.get(restrictionKey)).toEqual(expected)
      expect(f.writes.filter((key) => key === restrictionKey)).toHaveLength(1)
    })
  })

  test("keeps the total transport concurrency at four across multiple resources", async () => {
    const bodies = new Map<string, Uint8Array>()
    const resources: SourcePlanResource[] = []
    for (let resource = 0; resource < 2; resource++) {
      const files: Array<FixedFileManifest["files"][number]> = []
      const locations: { sha256: string; url: string }[] = []
      for (let index = 0; index < 6; index++) {
        const bytes = encode(`resource-${resource}-${index}`)
        const entry = fixedFile(`${index}.bin`, bytes)
        const url = `${httpUrl}/${resource}/${index}`
        files.push(entry)
        locations.push({ sha256: entry.sha256, url })
        bodies.set(url, bytes)
      }
      resources.push({ kind: "http", manifest: fixedManifest(...files), locations })
    }
    const f = fixture(bodies, true)
    const plan = sourcePlan(
      null,
      resources.map((resource, index) => ({ mount_path: `r${index}`, resource })),
    )
    const result = await f.run(materializeSharedSourcePlan(plan, { metrics: f.metrics }))
    expect(result.paths).toHaveLength(12)
    expect(f.requests).toHaveLength(12)
    expect(f.metrics.snapshot().peak_concurrency).toBe(4)
    expect(f.metrics.snapshot().in_flight).toBe(0)
  })

  test("cancellation stops active resource I/O before any later resource starts", async () => {
    const f = fixture()
    const started = Latch.makeUnsafe()
    const calls: string[] = []
    let cancelled = 0
    const client = HttpClient.make((_request, url) =>
      Effect.gen(function* () {
        calls.push(url.toString())
        if (calls.length === 4) started.openUnsafe()
        return yield* Effect.never.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              cancelled++
            }),
          ),
        )
      }),
    )
    const entries = Array.from({ length: 6 }, (_, index) =>
      fixedFile(`${index}.bin`, encode(`fixed-${index}`)),
    )
    const base: SourcePlanResource = {
      kind: "http",
      manifest: fixedManifest(...entries),
      locations: entries.map((entry) => ({
        sha256: entry.sha256,
        url: `${httpUrl}/${entry.path}`,
      })),
    }
    const plan = sourcePlan(base, [
      { mount_path: "later", resource: httpResource("asset", encode("later"), `${httpUrl}/later`) },
    ])
    await f.run(
      Effect.scoped(
        Effect.gen(function* () {
          const running = yield* Effect.forkChild(
            materializeSharedSourcePlan(plan, { metrics: f.metrics }),
          )
          yield* started.await
          yield* Fiber.interrupt(running)
        }),
      ),
      client,
    )
    expect(calls).toHaveLength(4)
    expect(cancelled).toBe(4)
    expect(calls.every((url) => !url.endsWith("/later"))).toBe(true)
    expect(f.objects.size).toBe(0)
    expect(f.metrics.snapshot().in_flight).toBe(0)
  })
})
