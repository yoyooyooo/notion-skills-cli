import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Layer } from "effect"
import { archiveOwnedPage } from "../src/owned-page-archive.ts"
import { authScope } from "../src/catalog.ts"
import { decode, fail, type SkillsError } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { Store } from "../src/store.ts"
import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"

const page = "11111111-1111-4111-8111-111111111111"
const child = "22222222-2222-4222-8222-222222222222"
const operation = "p_owned-archive-test"
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "owned-page-archive-"))
  const values = new Map<string, unknown>()
  const requests: { path: string; method: string; body?: unknown }[] = []
  const archived = new Set<string>()
  let unknown = false
  const store = Layer.succeed(Store, {
    root,
    configRoot: join(root, "config"),
    cacheRoot: join(root, "cache"),
    upstream: upstreamRepositoryFixture(),
    integrity: integrityRepositoryFixture(),
    reserveCacheGeneration: () => Effect.succeed(1),
    listKeys: (prefix) =>
      Effect.succeed([...values.keys()].filter((key) => key.startsWith(prefix))),
    retireKeys: () => Effect.die("Unexpected retirement"),
    readJson: (key, schema) =>
      Effect.try({
        try: () => (values.has(key) ? decode(schema, values.get(key)) : undefined),
        catch: () => fail("STATE_CORRUPT", "Invalid controlled receipt"),
      }),
    writeJson: (key, value) =>
      Effect.sync(() => {
        values.set(key, structuredClone(value))
      }),
    readBytes: () => Effect.die("Unexpected bytes read"),
    writeBytes: () => Effect.die("Unexpected bytes write"),
    registerBindingWithBase: () => Effect.die("Unexpected binding"),
    advanceBaseAndReceipt: () => Effect.die("Unexpected baseline"),
    backup: () => Effect.die("Unexpected backup"),
    output: () => Effect.die("Unexpected output"),
  })
  const api = Layer.succeed(Notion, {
    version: Effect.succeed("2026-03-11"),
    credentialIdentity: Effect.succeed("controlled-credential"),
    request: (path, body, options) =>
      Effect.gen(function* () {
        const method = options?.method ?? (body === undefined ? "GET" : "POST")
        requests.push({ path, method, body })
        if (path === "v1/users/me") return { object: "user", id: "controlled-user" }
        const id = path.slice("v1/pages/".length)
        if (![page, child].includes(id))
          return yield* Effect.fail(fail("NOT_FOUND", "Controlled page absent"))
        if (method === "PATCH") {
          expect(body).toEqual({ in_trash: true })
          expect(
            [...values.entries()].some(
              ([key, value]) =>
                key.startsWith("operations/owned-page-archive/") &&
                JSON.stringify(value).includes('"state":"unknown"'),
            ),
          ).toBe(true)
          if (unknown)
            return yield* Effect.fail(
              fail("WRITE_OUTCOME_UNKNOWN", "Controlled lost response", {
                phase: "outcome_unknown",
              }),
            )
          archived.add(id)
        }
        return { object: "page", id, in_trash: archived.has(id) }
      }),
  })
  const runtime = Layer.mergeAll(NodeServices.layer, store, api)
  const run = <A, E>(
    effect: Effect.Effect<A, E, Store | Notion | import("effect").Crypto.Crypto>,
  ) => Effect.runPromise(effect.pipe(Effect.provide(runtime)))
  const scope = await run(authScope)
  values.set(`publications/${operation}.json`, {
    format: 1,
    operation_id: operation,
    operation: "create",
    state: "completed",
    scope,
    page_id: page,
    portable: {
      kind: "skill",
      name: "Owned fixture",
      description: "Controlled archive",
      main: "SKILL.md",
      files: [],
    },
    guards: {},
    stages: [],
    intents: [page, child].map((id) => ({
      path: "v1/pages",
      method: "POST",
      status: "completed",
      response: { id },
    })),
  })
  return {
    run,
    scope,
    values,
    requests,
    archived,
    loseResponse: () => {
      unknown = true
    },
  }
}

test("owned archive requires exact completed original ownership and credential scope", async () => {
  const f = await fixture()
  for (const id of ["p_missing", "skill-create-" + "a".repeat(64)]) {
    const result = await f.run(archiveOwnedPage(page, id).pipe(Effect.result))
    expect(result._tag === "Failure" && result.failure.code).toBe("ARCHIVE_OWNERSHIP_REQUIRED")
  }
  const original = f.values.get(`publications/${operation}.json`) as Record<string, unknown>
  f.values.set(`publications/${operation}.json`, { ...original, scope: "foreign" })
  const result = await f.run(archiveOwnedPage(page, operation).pipe(Effect.result))
  expect(result._tag === "Failure" && result.failure.code).toBe("ARCHIVE_OWNERSHIP_REQUIRED")
  expect(f.requests.filter((request) => request.method === "PATCH")).toHaveLength(0)
})

test("owned archive dry-run exposes the original complete page set and success is read back", async () => {
  const f = await fixture()
  const preview = await f.run(archiveOwnedPage(page, operation, { dryRun: true }))
  expect(preview).toMatchObject({ dry_run: true, archived: false, owned_page_ids: [page, child] })
  expect(
    [...f.values.keys()].filter((key) => key.startsWith("operations/owned-page-archive/")),
  ).toHaveLength(0)
  expect(await f.run(archiveOwnedPage(child, operation))).toMatchObject({
    archived: true,
    verified: true,
    reused: false,
  })
  expect(await f.run(archiveOwnedPage(child, operation))).toMatchObject({
    archived: true,
    verified: true,
    reused: true,
  })
  expect(f.requests.filter((request) => request.method === "PATCH")).toHaveLength(1)
})

test("unknown owned archive always reads the original ID and never repeats its PATCH", async () => {
  const f = await fixture()
  f.loseResponse()
  for (let index = 0; index < 2; index += 1) {
    const result = await f.run(archiveOwnedPage(page, operation).pipe(Effect.result))
    expect(result._tag === "Failure" && result.failure.code).toBe("ARCHIVE_OUTCOME_UNKNOWN")
    if (result._tag === "Failure")
      expect(JSON.stringify(result.failure.details)).not.toContain('"archived":true')
  }
  expect(f.requests.filter((request) => request.method === "PATCH")).toHaveLength(1)
  f.archived.add(page)
  expect(await f.run(archiveOwnedPage(page, operation))).toMatchObject({
    archived: true,
    reused: true,
  })
  expect(f.requests.filter((request) => request.method === "PATCH")).toHaveLength(1)
})

test("shared owned archive accepts only the retained original native content page IDs", async () => {
  const f = await fixture(),
    id = "skill-create-" + "b".repeat(64)
  f.values.set(`operations/shared-native-create-owned/${f.scope}/${id}.json`, {
    version: 1,
    scope: f.scope,
    operation_id: id,
    library_id: "library-owned",
    skill_id: "skill-owned",
    skill_page_id: page,
    coverage: "created_native_content_pages",
    created_page_ids: [page, child],
    created_pages: [page, child].map((page_id, index) => ({
      page_id,
      kind: index === 0 ? "skill" : "file",
      database_id: page,
      data_source_id: child,
      file_id: "file-" + index,
    })),
  })
  expect(await f.run(archiveOwnedPage(child, id))).toMatchObject({ archived: true, verified: true })
  expect(f.requests.filter((request) => request.method === "PATCH")).toHaveLength(1)
})
