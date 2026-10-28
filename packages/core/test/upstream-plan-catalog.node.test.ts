import { expect, test, vi } from "vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import { ConfigProvider, Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Store, StoreLive, sha256 } from "../src/store.ts"
import { Notion } from "../src/notion.ts"
import { property } from "../src/model.ts"
import { portableIdentity } from "../src/export.ts"
import { planUpstream } from "../src/upstream-plan.ts"
import { readPublishedUpstreamPages } from "../src/upstream-identity.ts"
import { UpstreamState } from "../src/upstream-state.ts"
import { UpstreamPublisher, type ManagedContent, type Subscription } from "../src/upstream-model.ts"
import type { SourceSnapshot } from "../src/upstream-source.ts"
import { getSubscription } from "../src/upstream-subscription.ts"
import { discoverSource } from "../src/upstream-source.ts"
import type * as SubscriptionModule from "../src/upstream-subscription.ts"
import type * as SourceModule from "../src/upstream-source.ts"

vi.mock("../src/upstream-subscription.ts", async (original) => ({
  ...(await original<typeof SubscriptionModule>()),
  getSubscription: vi.fn(),
}))
vi.mock("../src/upstream-source.ts", async (original) => ({
  ...(await original<typeof SourceModule>()),
  discoverSource: vi.fn(),
}))

const sub = "11111111-1111-4111-8111-111111111111"
const peer = "77777777-7777-4777-8777-777777777777"
const db = "22222222-2222-4222-8222-222222222222"
const ds = "33333333-3333-4333-8333-333333333333"
const otherDs = "88888888-8888-4888-8888-888888888888"
const idAt = (i: number) => `66666666-6666-4666-8666-${String(i).padStart(12, "0")}`
const rich = (value: string) => ({ type: "rich_text", rich_text: [{ plain_text: value }] })
const subscription: Subscription = {
  subscription_id: sub,
  database_id: "99999999-9999-4999-8999-999999999999",
  data_source_id: otherDs,
  target_database_id: db,
  name: "source",
  description: "source",
  default_context: false,
  enabled: true,
  removed: false,
  status: "pending",
  source: { provider: { type: "git", url: "/offline/fixture", ref: "main" } },
  roots: ["skills"],
  include: [],
  exclude: [],
  mapping: {},
  published: null,
  version: "subscription-v1",
}

function inventory(
  options: { secondSource?: boolean; wrongParent?: boolean; rows?: unknown[] } = {},
) {
  const requests: { path: string; body: unknown }[] = []
  let user = "scope-one"
  const notion = Notion.of({
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("fixture"),
    request: (path, body) =>
      Effect.sync(() => {
        requests.push({ path, body })
        if (path === "v1/users/me") return { id: user, object: "user" }
        if (path === `v1/databases/${db}`)
          return {
            id: db,
            database_type: null,
            title: [],
            data_sources: [ds, ...(options.secondSource ? [otherDs] : [])].map((id) => ({
              id,
              name: id,
            })),
          }
        if (path === `v1/data_sources/${ds}` || path === `v1/data_sources/${otherDs}`)
          return {
            id: path.split("/").at(-1),
            parent: { database_id: options.wrongParent ? peer : db },
            title: [],
            properties: {
              Name: { id: "title", type: "title" },
              Upstream: { id: "owner", type: "relation" },
              "Upstream Key": { id: "key", type: "rich_text" },
            },
          }
        if (path.endsWith("/query")) {
          expect(property(body).filter).toEqual({ property: "owner", relation: { contains: sub } })
          expect(property(body).page_size).toBe(100)
          const rows = path.includes(otherDs) ? [] : (options.rows ?? [])
          const offset = property(body).start_cursor ? 100 : 0
          return {
            results: rows.slice(offset, offset + 100),
            has_more: rows.length > offset + 100,
            next_cursor: rows.length > offset + 100 ? "second-page" : null,
          }
        }
        throw new Error(`Unexpected request ${path}`)
      }),
  })
  return {
    notion,
    requests,
    changeScope: () => {
      user = "scope-two"
    },
  }
}

function row(i: number, key: string, owner = sub) {
  return {
    id: idAt(i),
    parent: { database_id: db, data_source_id: ds },
    properties: {
      Upstream: { id: "owner", type: "relation", relation: [{ id: owner }], has_more: false },
      "Upstream Key": { id: "key", ...rich(key) },
      Kind: { type: "select", select: { name: "skill" } },
    },
  }
}

test("176-member plans preserve every identity, action and 1282 resource hashes with one two-page inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntn-plan-catalog-"))
  vi.stubEnv("NTN_SKILLS_HOME", join(root, "state"))
  vi.stubEnv("NTN_SKILLS_CONFIG_HOME", join(root, "config"))
  vi.stubEnv("NTN_SKILLS_CACHE_HOME", join(root, "cache"))
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* Store
          const members: SourceSnapshot["members"][number][] = []
          const pages = new Map<string, ManagedContent>()
          for (let i = 0; i < 176; i++) {
            const portable = {
              kind: "skill" as const,
              name: `member-${i}`,
              description: "Use for the complete plan regression",
              main: "SKILL.md",
              files: Array.from({ length: i < 50 ? 8 : 7 }, (_, file) => ({
                path: file === 0 ? "SKILL.md" : `references/${file}.md`,
                bytes: new TextEncoder().encode(`member ${i} resource ${file}\n`),
              })),
            }
            const hash = yield* portableIdentity(portable)
            const key = `skills/member-${i}`
            members.push({
              member_key: key,
              source_path: key,
              portable,
              upstream_hash: hash,
              content_hash: hash,
            })
            pages.set(idAt(i), {
              page_id: idAt(i),
              version: `version-${i}`,
              portable,
              content_hash: i % 5 === 1 ? "e".repeat(64) : hash,
              ownership: {
                subscription_id: i % 5 === 4 ? peer : sub,
                member_key: key,
                mode: i % 5 === 3 ? "fork" : "tracked",
                published_hash: i % 5 === 2 ? "d".repeat(64) : i % 5 === 1 ? "e".repeat(64) : hash,
                revision: "before",
              },
            })
          }
          const snapshot: SourceSnapshot = { revision: "frozen-revision", provenance: {}, members }
          vi.mocked(discoverSource).mockReturnValue(Effect.succeed(snapshot))
          const fixture = inventory({ rows: members.map((member, i) => row(i, member.member_key)) })
          const publisher = UpstreamPublisher.of({
            inspect: (id) => Effect.succeed(pages.get(id)!),
            publish: () => Effect.die("plan wrote content"),
            reconcile: () => Effect.die("plan reconciled content"),
            setMode: () => Effect.die("plan changed mode"),
            recoverableBaseline: () => Effect.die("plan wrote baseline"),
            readBaseline: () => Effect.die("plan read baseline"),
          })
          vi.mocked(getSubscription).mockReturnValue(Effect.succeed(subscription))
          const execute = planUpstream(sub).pipe(
            Effect.provideService(Notion, fixture.notion),
            Effect.provideService(UpstreamState, store.upstream),
            Effect.provideService(UpstreamPublisher, publisher),
          )
          const optimized = yield* execute
          expect(fixture.requests.filter((r) => r.path === `v1/databases/${db}`)).toHaveLength(1)
          expect(fixture.requests.filter((r) => r.path === `v1/data_sources/${ds}`)).toHaveLength(1)
          expect(fixture.requests.filter((r) => r.path.endsWith("/query"))).toHaveLength(2)
          expect(optimized.items).toHaveLength(176)
          expect(optimized.source_manifest!.members.flatMap((m) => m.resources)).toHaveLength(1282)
          for (let i = 0; i < members.length; i++) {
            const member = members[i]!
            const item = optimized.items.find((item) => item.member_key === member.member_key)!
            expect(item.page_id).toBe(idAt(i))
            expect(item.content_hash).toBe(member.content_hash)
            expect(item.candidate).toEqual({
              kind: "skill",
              name: member.portable.name,
              description: member.portable.description,
              main: member.portable.main,
              files: yield* Effect.forEach(
                [...member.portable.files].sort((a, b) => a.path.localeCompare(b.path)),
                (file) =>
                  sha256(file.bytes).pipe(Effect.map((hash) => ({ path: file.path, hash }))),
              ),
            })
            expect(item.accepted).toEqual(item.candidate)
            expect(item.action).toBe(["unchanged", "update", "conflict", "fork", "conflict"][i % 5])
            for (const file of member.portable.files)
              expect(
                optimized.source_manifest!.members.find((m) => m.member_key === member.member_key)!
                  .resources,
              ).toContainEqual({ path: file.path, sha256: yield* sha256(file.bytes) })
          }
          // The existing exact remote map bypasses identity discovery; compare the entire planned behavior.
          vi.mocked(getSubscription).mockReturnValue(
            Effect.succeed({
              ...subscription,
              published: {
                version: 1,
                revision: snapshot.revision,
                plan_hash: "a".repeat(64),
                publisher_subscription_id: sub,
                members: members.map((member, i) => ({
                  member_key: member.member_key,
                  page_id: idAt(i),
                  content_hash: member.content_hash,
                })),
              },
            }),
          )
          fixture.requests.length = 0
          const mapped = yield* execute
          const { created_at: _a, plan_id: _b, plan_hash: _c, ...optimizedBody } = optimized
          const { created_at: _d, plan_id: _e, plan_hash: _f, ...mappedBody } = mapped
          expect(mappedBody).toEqual(optimizedBody)
          expect(fixture.requests.filter((r) => !r.path.endsWith("users/me"))).toEqual([])
          vi.mocked(getSubscription).mockReturnValue(Effect.succeed(subscription))
          fixture.changeScope()
          fixture.requests.length = 0
          const anotherScope = yield* execute
          expect(anotherScope.scope).not.toBe(optimized.scope)
          expect(anotherScope.items).toEqual(optimized.items)
          expect(fixture.requests.filter((r) => r.path.endsWith("/query"))).toHaveLength(2)
          vi.mocked(getSubscription).mockReturnValue(
            Effect.succeed({
              ...subscription,
              subscription_id: peer,
              source: {
                ...subscription.source,
                shared_target_set: "shared-synpraxis-smip",
                publisher_subscription_id: sub,
                accepted_ref: "accepted",
              },
            }),
          )
          fixture.requests.length = 0
          const shared = yield* planUpstream(peer).pipe(
            Effect.provideService(Notion, fixture.notion),
            Effect.provideService(UpstreamState, store.upstream),
            Effect.provideService(UpstreamPublisher, publisher),
          )
          expect(shared.publisher_subscription_id).toBe(sub)
          expect(
            shared.items.map(({ member_key, page_id, action, content_hash, candidate }) => ({
              member_key,
              page_id,
              action,
              content_hash,
              candidate,
            })),
          ).toEqual(
            optimized.items.map(({ member_key, page_id, action, content_hash, candidate }) => ({
              member_key,
              page_id,
              action,
              content_hash,
              candidate,
            })),
          )
          expect(fixture.requests.filter((r) => r.path.endsWith("/query"))).toHaveLength(2)
        }),
      ).pipe(
        Effect.provide(StoreLive),
        Effect.provide(NodeServices.layer),
        Effect.provide(NodeHttpClient.layerFetch),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
      ),
    )
  } finally {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
}, 180_000)

test.each(["duplicate", "kind", "truncated-owner", "foreign-source", "foreign-database"])(
  "publisher inventory refuses %s identity evidence",
  async (scenario) => {
    const first = row(1, "skills/alpha")
    const rows: unknown[] = [first]
    if (scenario === "duplicate") rows.push(row(2, "skills/alpha"))
    if (scenario === "kind") first.properties.Kind.select.name = "router"
    if (scenario === "truncated-owner") first.properties.Upstream.has_more = true
    if (scenario === "foreign-source") first.parent.data_source_id = otherDs
    const fixture = inventory({ rows, wrongParent: scenario === "foreign-database" })
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const lookup = yield* readPublishedUpstreamPages(db, sub)
        return yield* lookup("skills/alpha", "skill")
      }).pipe(Effect.provideService(Notion, fixture.notion), Effect.result),
    )
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        code:
          scenario === "duplicate" || scenario === "kind"
            ? "UPSTREAM_IDENTITY_CONFLICT"
            : scenario === "truncated-owner"
              ? "INVALID_UPSTREAM"
              : scenario === "foreign-database"
                ? "DATABASE_SCHEMA_CONFLICT"
                : "INVALID_RESPONSE",
      },
    })
  },
)

test("publisher and source boundaries exclude manual and foreign owners while paging every data source", async () => {
  const manual = { id: idAt(1), parent: { data_source_id: ds }, properties: {} }
  const noKey = row(2, "")
  const rows = [manual, noKey, row(3, "skills/alpha", peer), row(4, "skills/beta")]
  const fixture = inventory({ rows, secondSource: true })
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const lookup = yield* readPublishedUpstreamPages(db, sub)
      return [yield* lookup("skills/alpha", "skill"), yield* lookup("skills/beta", "skill")]
    }).pipe(Effect.provideService(Notion, fixture.notion)),
  )
  expect(result).toEqual([undefined, idAt(4)])
  expect(fixture.requests.filter((r) => r.path.endsWith("/query"))).toHaveLength(2)
})
