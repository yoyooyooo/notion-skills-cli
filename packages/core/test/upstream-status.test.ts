import { expect, test } from "bun:test"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Clock, Crypto, Effect } from "effect"
import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"
import { decode, fail } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { Store } from "../src/store.ts"
import { UpstreamState } from "../src/upstream-state.ts"
import { checkUpstreamObservation, statusUpstreamObservation } from "../src/upstream-status.ts"
import type { PublishedMembers } from "../src/upstream-model.ts"

const subscription = "11111111-1111-4111-8111-111111111111"
const database = "22222222-2222-4222-8222-222222222222"
const dataSource = "33333333-3333-4333-8333-333333333333"
const target = "44444444-4444-4444-8444-444444444444"
const targetSource = "55555555-5555-4555-8555-555555555555"
const alpha = {
  member_key: "skills/alpha",
  page_id: "66666666-6666-4666-8666-666666666666",
  content_hash: "a".repeat(64),
}
const beta = {
  member_key: "skills/beta",
  page_id: "77777777-7777-4777-8777-777777777777",
  content_hash: "b".repeat(64),
}
const rich = (value: string) => ({ type: "rich_text", rich_text: [{ plain_text: value }] })
const published = (members: PublishedMembers["members"]): PublishedMembers => ({
  version: 1,
  revision: "accepted-commit",
  plan_hash: "c".repeat(64),
  publisher_subscription_id: subscription,
  members,
})

type Denial = "none" | "auth" | "subscription" | "target" | "query"

interface MetadataBoundary {
  readonly requests: ReadonlyArray<{ path: string; method: string; body: unknown }>
  readonly writes: readonly string[]
  readonly observationWrites: readonly string[]
  readonly bodyAccesses: readonly string[]
}

function memberRow(member: typeof alpha, state: "committed" | "writing") {
  const common = {
    version: 2,
    operation_id: `publish:${member.member_key}`,
    intended_hash: member.content_hash,
    state,
  }
  return {
    id: member.page_id,
    parent: { database_id: target, data_source_id: targetSource },
    last_edited_time: "2026-10-17T10:00:00.000Z",
    properties: {
      Name: {
        id: "title",
        type: "title",
        title: [{ plain_text: member.member_key.split("/").at(-1)! }],
      },
      Upstream: { type: "relation", relation: [{ id: subscription }], has_more: false },
      "Upstream Key": rich(member.member_key),
      "Published Hash": rich(member.content_hash),
      "Sync Mode": { type: "select", select: { name: "tracked" } },
      Publication: rich(
        JSON.stringify(
          state === "writing"
            ? common
            : {
                ...common,
                revision: "d".repeat(64),
                manifest_hash: "e".repeat(64),
                ownership_hash: "f".repeat(64),
              },
        ),
      ),
    },
  }
}

function fixture(active: PublishedMembers["members"] = [alpha], status = "partial") {
  let now = 1_000_000,
    credential = "status-credential"
  let denied: Denial = "none"
  const requests: Array<{ path: string; method: string; body: unknown }> = []
  const json = new Map<string, unknown>([["config.json", { upstream_database: database }]])
  const writes: string[] = [],
    observationWrites: string[] = [],
    bodyAccesses: string[] = []
  const rows = [memberRow(alpha, "committed"), memberRow(beta, "writing")]
  const repository = upstreamRepositoryFixture()
  const unexpected = (action: string) =>
    Effect.die(new Error(`Unexpected status capability: ${action}`))
  const upstream = {
    ...repository,
    savePlan: () => unexpected("plan write"),
    saveOperation: () => unexpected("operation write"),
    setMode: () => unexpected("binding mode write"),
    advance: () => unexpected("binding advance"),
    saveCommand: (id: string, value: unknown) =>
      Effect.gen(function* () {
        observationWrites.push(id)
        if (!id.startsWith("upstream-observation:")) return yield* unexpected(`command write ${id}`)
        yield* repository.saveCommand(id, value)
      }),
  }
  const store = Store.of({
    root: "/state",
    configRoot: "/config",
    cacheRoot: "/cache",
    upstream,
    integrity: integrityRepositoryFixture(),
    reserveCacheGeneration: () => unexpected("cache generation"),
    listKeys: (prefix) =>
      Effect.sync(() => [...json.keys()].filter((key) => key.startsWith(prefix + "/"))),
    retireKeys: () => unexpected("cache retirement"),
    readJson: (key, schema) =>
      Effect.try({
        try: () => (json.has(key) ? decode(schema, structuredClone(json.get(key))) : undefined),
        catch: () => fail("STATE_CORRUPT", "Invalid status fixture observation."),
      }),
    writeJson: (key, value) =>
      Effect.gen(function* () {
        writes.push(key)
        if (!key.startsWith("cache/identities/")) return yield* unexpected(`JSON write ${key}`)
        json.set(key, structuredClone(value))
      }),
    readBytes: (key) =>
      Effect.gen(function* () {
        bodyAccesses.push(`read ${key}`)
        return yield* unexpected("body read")
      }),
    writeBytes: (key) =>
      Effect.gen(function* () {
        bodyAccesses.push(`write ${key}`)
        return yield* unexpected("body write")
      }),
    registerBindingWithBase: () => unexpected("binding transaction"),
    advanceBaseAndReceipt: () => unexpected("baseline transaction"),
    backup: () => unexpected("backup"),
    output: () => unexpected("export"),
  })
  const api = Notion.of({
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.sync(() => credential),
    request: (path, body, options) =>
      Effect.gen(function* () {
        const method = options?.method ?? (body === undefined ? "GET" : "POST")
        requests.push({ path, method, body })
        if (
          method !== "GET" &&
          !(method === "POST" && path === `v1/data_sources/${targetSource}/query`)
        )
          return yield* unexpected(`remote mutation ${method} ${path}`)
        if (denied === "auth" && path === "v1/users/me")
          return yield* Effect.fail(fail("ACCESS_DENIED", "Selected credential is inaccessible."))
        if (path === "v1/users/me") return { object: "user", id: "status-user" }
        if (path === `v1/databases/${database}` || path === `v1/databases/${target}`) {
          if (denied === "target" && path === `v1/databases/${target}`)
            return yield* Effect.fail(
              fail("ACCESS_DENIED", "Selected target database is inaccessible."),
            )
          const upstreamDatabase = path === `v1/databases/${database}`
          return {
            id: upstreamDatabase ? database : target,
            database_type: null,
            title: [],
            data_sources: [
              { id: upstreamDatabase ? dataSource : targetSource, name: "Status fixture" },
            ],
          }
        }
        if (path === `v1/pages/${subscription}`) {
          if (denied === "subscription")
            return yield* Effect.fail(
              fail("ACCESS_DENIED", "Selected subscription is inaccessible."),
            )
          return {
            id: subscription,
            parent: { database_id: database, data_source_id: dataSource },
            last_edited_time: "2026-10-17T09:00:00.000Z",
            properties: {
              Name: { id: "title", type: "title", title: [{ plain_text: "controlled" }] },
              Description: rich("Controlled metadata status"),
              Source: rich(
                JSON.stringify({
                  provider: { type: "git", url: "file:///unused-status-source", ref: "main" },
                }),
              ),
              Ref: rich("main"),
              Roots: rich('["skills"]'),
              Include: rich("[]"),
              Exclude: rich("[]"),
              Mapping: rich("{}"),
              "Published Members": rich(JSON.stringify(published(active))),
              "Target Database ID": rich(target),
              Enabled: { type: "checkbox", checkbox: true },
              "Default Context": { type: "checkbox", checkbox: false },
              Status: { type: "select", select: { name: status } },
            },
          }
        }
        if (path === `v1/data_sources/${targetSource}/query`) {
          if (denied === "query")
            return yield* Effect.fail(
              fail("ACCESS_DENIED", "Selected member directory is inaccessible."),
            )
          const cursor = (body as { start_cursor?: string } | undefined)?.start_cursor
          expect(body).toEqual({
            page_size: 100,
            filter: { property: "Upstream", relation: { contains: subscription } },
            ...(cursor ? { start_cursor: "next-member" } : {}),
          })
          return cursor
            ? { results: rows.slice(1), has_more: false, next_cursor: null }
            : { results: rows.slice(0, 1), has_more: true, next_cursor: "next-member" }
        }
        const member = rows.find((row) => path === `v1/pages/${row.id}`)
        if (member) return member
        return yield* unexpected(`remote body/discovery request ${path}`)
      }),
  })
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
    monotonicTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
    sleep: () => Effect.void,
  }
  return {
    requests,
    json,
    writes,
    observationWrites,
    rows,
    bodyAccesses,
    deny: (value: Denial) => {
      denied = value
    },
    time: (value: number) => {
      now = value
    },
    credential: (value: string) => {
      credential = value
    },
    run: <A, E>(effect: Effect.Effect<A, E, Store | Notion | UpstreamState | Crypto.Crypto>) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provideService(Store, store),
          Effect.provideService(Notion, api),
          Effect.provideService(UpstreamState, upstream),
          Effect.provideService(Clock.Clock, clock),
          Effect.provide(NodeServices.layer),
        ),
      ),
  }
}

function expectMetadataOnly(f: MetadataBoundary) {
  expect(f.bodyAccesses).toEqual([])
  expect(
    f.requests.some(({ path }) => /blocks|markdown|\/properties\/|v1\/search/.test(path)),
  ).toBe(false)
  expect(
    f.requests.every(
      ({ method, path }) =>
        method === "GET" || (method === "POST" && path === `v1/data_sources/${targetSource}/query`),
    ),
  ).toBe(true)
  expect(f.writes.every((key) => key.startsWith("cache/identities/"))).toBe(true)
  expect(
    f.observationWrites.every(
      (key) => key.startsWith("upstream-observation:") && key.endsWith(`:${subscription}`),
    ),
  ).toBe(true)
}

test("a single committed member stays active without a Router and status reuses its scoped observation offline", async () => {
  const f = fixture()
  const checked = await f.run(checkUpstreamObservation(subscription))
  expect(checked.state.aggregate_status).toBe("partial")
  expect(checked.state.router).toMatchObject({
    availability: "unavailable",
    exact_ref: `skill://upstream%3A${subscription}/ROUTER.md`,
    active_member_count: 1,
    active_member_ids: [alpha.page_id],
    published_member_ids: [alpha.page_id],
    body_verified: false,
  })
  expect(checked.members).toEqual([
    expect.objectContaining({
      member_key: alpha.member_key,
      page_id: alpha.page_id,
      candidate: null,
      publication: "committed",
      active: true,
      conflict: false,
      mode: "tracked",
      evidence: expect.objectContaining({
        metadata_observed: true,
        version: "2026-10-17T10:00:00.000Z",
      }),
    }),
    expect.objectContaining({
      member_key: beta.member_key,
      page_id: beta.page_id,
      candidate: null,
      publication: "writing",
      active: false,
      conflict: false,
      mode: "tracked",
    }),
  ])
  expect(checked.state.observation).toMatchObject({
    source: "notion_metadata",
    member_bodies_read: false,
    freshness: { validated_at: "1970-01-01T00:16:40.000Z", age_ms: 0, current: true },
  })
  expect(checked.failed_sources).toEqual([])
  expect(checked.coverage).toMatchObject({
    complete: true,
    directory_observed: true,
    observed_member_ids: [alpha.page_id, beta.page_id],
  })
  expect(f.requests.filter(({ path }) => path.endsWith("/query"))).toHaveLength(2)
  expect(
    f.requests.some(
      ({ path }) => path === `v1/pages/${alpha.page_id}` || path === `v1/pages/${beta.page_id}`,
    ),
  ).toBe(false)
  expectMetadataOnly(f)
  const writes = [...f.writes]
  const observationWrites = [...f.observationWrites]
  expect(observationWrites).toHaveLength(1)
  f.requests.length = 0
  f.deny("auth")
  f.time(1_005_000)
  const offline = await f.run(statusUpstreamObservation(subscription))
  expect(offline.state.router).toEqual(checked.state.router)
  expect(offline.state.members).toEqual(checked.members)
  expect(offline.state.observation).toMatchObject({
    source: "local_observation",
    member_bodies_read: false,
    freshness: { validated_at: "1970-01-01T00:16:40.000Z", age_ms: 5_000, current: false },
  })
  expect(f.requests).toEqual([])
  expect(f.writes).toEqual(writes)
  expect(f.observationWrites).toEqual(observationWrites)
  expectMetadataOnly(f)
})

test("metadata check cannot expose a router when every published active member is writing", async () => {
  const f = fixture([alpha, beta])
  f.rows[0] = memberRow(alpha, "writing")
  const checked = await f.run(checkUpstreamObservation(subscription))
  expect(checked.state.router).toMatchObject({
    availability: "unavailable",
    active_member_count: 0,
    active_member_ids: [],
    published_member_ids: [alpha.page_id, beta.page_id],
    body_verified: false,
  })
  expect(
    checked.members.every((member) => member.publication === "writing" && member.active === false),
  ).toBe(true)
  f.requests.length = 0
  expect((await f.run(statusUpstreamObservation(subscription))).state.router).toEqual(
    checked.state.router,
  )
  expect(f.requests).toEqual([])
  expectMetadataOnly(f)
})

for (const { active, status, availability } of [
  { active: [], status: "verified", availability: "unavailable" },
  { active: [alpha], status: "verified", availability: "unavailable" },
  { active: [alpha, beta], status: "verified", availability: "ready" },
  { active: [alpha, beta], status: "partial", availability: "partial" },
]) {
  test(`Router availability with ${active.length} active Skills and ${status} status`, async () => {
    const f = fixture(active, status)
    f.rows[1] = memberRow(beta, "committed")
    const checked = await f.run(checkUpstreamObservation(subscription))
    expect(checked.state.router).toMatchObject({
      availability,
      active_member_count: active.length,
      active_member_ids: active.map((member) => member.page_id),
      published_member_ids: active.map((member) => member.page_id),
    })
    f.requests.length = 0
    expect((await f.run(statusUpstreamObservation(subscription))).state.router).toEqual(
      checked.state.router,
    )
    expect(f.requests).toEqual([])
    expectMetadataOnly(f)
  })
}

test("offline status without an observation reports unknown and performs no network or writes", async () => {
  const f = fixture()
  f.deny("auth")
  const offline = await f.run(statusUpstreamObservation(subscription))
  expect(offline.subscription).toBeNull()
  expect(offline.state).toMatchObject({
    aggregate_status: "unknown",
    members: [],
    router: {
      availability: "unknown",
      exact_ref: `skill://upstream%3A${subscription}/ROUTER.md`,
      active_member_count: null,
      active_member_ids: null,
      membership_observed: false,
      body_verified: false,
    },
    observation: {
      source: "none",
      freshness: { current: false },
      directory: "unknown",
      member_bodies_read: false,
    },
    failed_sources: [],
    coverage: { complete: false, directory_observed: false, observed_member_ids: [] },
  })
  expect(f.requests).toEqual([])
  expect(f.writes).toEqual([])
  expect(f.observationWrites).toEqual([])
  expectMetadataOnly(f)
})

test("unknown member metadata stays unknown while a single-member Router remains unavailable", async () => {
  const f = fixture([alpha], "verified")
  f.rows.splice(1)
  const row = f.rows[0]!
  const { Upstream: _relation, ...properties } = row.properties
  f.rows[0] = { ...row, properties } as typeof row
  const checked = await f.run(checkUpstreamObservation(subscription))
  expect(checked.state.router.availability).toBe("unavailable")
  expect(checked.members[0]).toMatchObject({
    publication: "committed",
    active: null,
    conflict: null,
  })
  expectMetadataOnly(f)
})

test("an inaccessible selected member directory remains explicit even when an exact committed member is readable", async () => {
  const f = fixture([alpha], "verified")
  f.deny("query")
  const checked = await f.run(checkUpstreamObservation(subscription))
  expect(checked.failed_sources).toContainEqual(
    expect.objectContaining({
      code: "ACCESS_DENIED",
      message: "Selected member directory is inaccessible.",
    }),
  )
  expect(checked.coverage).toMatchObject({ complete: false, directory_observed: false })
  expect(checked.state.router.availability).toBe("unknown")
  expect(f.requests).toContainEqual(
    expect.objectContaining({ path: `v1/pages/${alpha.page_id}`, method: "GET" }),
  )
  expectMetadataOnly(f)
  f.requests.length = 0
  const offline = await f.run(statusUpstreamObservation(subscription))
  expect(offline.state.failed_sources).toEqual(checked.failed_sources)
  expect(offline.state.coverage).toEqual(checked.coverage)
  expect(offline.state.router.availability).toBe(checked.state.router.availability)
  expect(f.requests).toEqual([])
  expectMetadataOnly(f)
})

test("authentication, exact subscription and target denial fail explicitly instead of returning cached valid availability", async () => {
  const f = fixture([alpha, beta], "verified")
  f.rows[1] = memberRow(beta, "committed")
  const prior = await f.run(checkUpstreamObservation(subscription))
  expect(prior.state.router.availability).toBe("ready")
  const writes = [...f.writes]
  const observationWrites = [...f.observationWrites]
  for (const denial of ["auth", "subscription", "target"] as const) {
    f.requests.length = 0
    f.deny(denial)
    const denied = await f.run(checkUpstreamObservation(subscription).pipe(Effect.result))
    expect(denied).toMatchObject({
      _tag: "Failure",
      failure: {
        code: "ACCESS_DENIED",
        details: {
          failed_sources: [
            {
              id:
                denial === "auth"
                  ? "selected_auth"
                  : denial === "subscription"
                    ? subscription
                    : target,
              code: "ACCESS_DENIED",
            },
          ],
          coverage: { complete: false, directory_observed: false },
        },
      },
    })
    expect(f.writes).toEqual(writes)
    expect(f.observationWrites).toEqual(observationWrites)
    expect(f.requests.some(({ path }) => path.endsWith("/query"))).toBe(false)
  }
  expectMetadataOnly(f)
})

test("offline status does not reuse another credential's successful observation", async () => {
  const f = fixture()
  await f.run(checkUpstreamObservation(subscription))
  const writes = [...f.writes]
  f.requests.length = 0
  f.credential("unobserved-credential")
  f.deny("auth")
  const offline = await f.run(statusUpstreamObservation(subscription))
  expect(offline.subscription).toBeNull()
  expect(offline.state.router).toMatchObject({
    availability: "unknown",
    active_member_count: null,
    active_member_ids: null,
    membership_observed: false,
  })
  expect(offline.state.observation.source).toBe("none")
  expect(f.requests).toEqual([])
  expect(f.writes).toEqual(writes)
  expectMetadataOnly(f)
})
