import { expect, test, vi } from "vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import { ConfigProvider, Crypto, Effect, Layer } from "effect"
import type { HttpClient } from "effect/http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Store, StoreLive } from "../src/store.ts"
import { Notion } from "../src/notion.ts"
import { catalog } from "../src/catalog.ts"
import { readSkill } from "../src/snapshot.ts"
import { authScope } from "../src/catalog.ts"
import { ObservationSchema } from "../src/cache.ts"
import {
  addSubscription,
  updateSubscription,
  removeSubscription,
  getSubscription,
  reconcileSubscriptionCommand,
  resumeSubscriptionCommand,
  planSubscriptionAdoption,
  applySubscriptionAdoption,
  publishSubscriptionMembers,
} from "../src/upstream-subscription.ts"
import { UpstreamState } from "../src/upstream-state.ts"
import { CatalogSchema, fail, property } from "../src/model.ts"
import {
  strictDecode,
  UpstreamCommandOperationSchema,
  type SubscriptionInput,
} from "../src/upstream-model.ts"

const sub = "11111111-1111-4111-8111-111111111111"
const db = "22222222-2222-4222-8222-222222222222"
const ds = "33333333-3333-4333-8333-333333333333"
const target = "44444444-4444-4444-8444-444444444444"
const targetDs = "55555555-5555-4555-8555-555555555555"
const bad = "66666666-6666-4666-8666-666666666666"
const rich = (value: string, type = "rich_text") => ({
  ...(type === "title" ? { id: "title" } : {}),
  type,
  [type]: [{ plain_text: value }],
})
const input: SubscriptionInput = {
  name: "Controlled Source",
  description: "Controlled metadata boundary",
  target_database_id: target,
  default_context: false,
  enabled: true,
  source: { provider: { type: "git", url: "file:///unused", ref: "main" } },
  roots: ["skills"],
  include: [],
  exclude: [],
  mapping: {},
}
const published = {
  version: 1 as const,
  revision: "fixed",
  plan_hash: "a".repeat(64),
  publisher_subscription_id: sub,
  members: [],
}
const routedMembers = {
  ...published,
  members: [
    {
      member_key: "skills/alpha",
      page_id: "77777777-7777-4777-8777-777777777777",
      content_hash: "b".repeat(64),
    },
    {
      member_key: "skills/beta",
      page_id: "88888888-8888-4888-8888-888888888888",
      content_hash: "c".repeat(64),
    },
  ],
}
const routedRows = routedMembers.members.map((member, index) => ({
  id: member.page_id,
  parent: { database_id: target, data_source_id: targetDs },
  properties: {
    Name: rich(index === 0 ? "Alpha" : "Beta", "title"),
    Description: rich("Use for controlled routing"),
    Upstream: { type: "relation", relation: [{ id: sub }], has_more: false },
    "Upstream Key": rich(member.member_key),
    "Published Hash": rich(member.content_hash),
    Publication: rich(
      JSON.stringify({
        version: 2,
        operation_id: `publish:${member.member_key}`,
        state: "committed",
        intended_hash: member.content_hash,
        revision: "d".repeat(64),
        manifest_hash: "e".repeat(64),
        ownership_hash: "f".repeat(64),
      }),
    ),
  },
}))
const routedQuery = (path: string) =>
  path === `v1/data_sources/${targetDs}/query`
    ? { results: routedRows, has_more: false, next_cursor: null }
    : undefined

async function boundary(
  operation: (state: {
    requests: string[]
    props: Record<string, unknown>
    rows: Map<string, unknown>
    children: Map<string, unknown[]>
    bodies: { path: string; body: unknown }[]
    failNext: (path: string, code?: string) => void
    loseNextWrite: (apply: boolean) => void
    respond: (handler: (path: string, body: unknown) => unknown) => void
    editExternally: (values: Record<string, unknown>, removed?: boolean) => void
    deny: (value: boolean) => void
  }) => Effect.Effect<
    unknown,
    unknown,
    Store | Notion | UpstreamState | Crypto.Crypto | HttpClient.HttpClient
  >,
) {
  const root = await mkdtemp(join(tmpdir(), "ntn-boundary-"))
  vi.stubEnv("NTN_SKILLS_HOME", join(root, "state"))
  vi.stubEnv("NTN_SKILLS_CONFIG_HOME", join(root, "config"))
  vi.stubEnv("NTN_SKILLS_CACHE_HOME", join(root, "cache"))
  const requests: string[] = [],
    rows = new Map<string, unknown>(),
    children = new Map<string, unknown[]>(),
    bodies: { path: string; body: unknown }[] = []
  let denied = false,
    revision = 0,
    removed = false
  let failure: { path: string; code: string } | undefined
  let lostWrite: { apply: boolean } | undefined
  let response: ((path: string, body: unknown) => unknown) | undefined
  const props: Record<string, unknown> = {
    Name: rich(input.name, "title"),
    Description: rich(input.description),
    Source: rich(JSON.stringify(input.source)),
    "Source URL": { type: "url", url: null },
    Ref: rich("main"),
    Roots: rich('["skills"]'),
    Include: rich("[]"),
    Exclude: rich("[]"),
    Mapping: rich("{}"),
    "Published Members": rich(""),
    "Target Database ID": rich(target),
    Enabled: { type: "checkbox", checkbox: true },
    "Default Context": { type: "checkbox", checkbox: false },
    Status: { type: "select", select: { name: "pending" } },
  }
  const row = () => ({
    id: sub,
    parent: { database_id: db, data_source_id: ds },
    properties: props,
    last_edited_time: String(revision),
    created_time: "2026-10-18T00:00:00.000Z",
    in_trash: removed,
  })
  const notion = Notion.of({
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("boundary-credential"),
    request: (path, body, options) =>
      Effect.try({
        try: () => {
          requests.push(`${options?.method ?? (body ? "POST" : "GET")} ${path}`)
          if (body !== undefined) bodies.push({ path, body })
          if (failure?.path === path) {
            const code = failure.code
            failure = undefined
            throw Object.assign(new Error("Controlled preflight failure"), { code })
          }
          const supplied = response?.(path, body)
          if (supplied !== undefined) return supplied
          if (path === "v1/users/me") return { id: "boundary-user", object: "user" }
          if (denied)
            throw Object.assign(new Error("Controlled permission denial"), {
              code: "ACCESS_DENIED",
            })
          if (path === `v1/databases/${db}` || path === `v1/databases/${target}`)
            return {
              id: path.endsWith(db) ? db : target,
              database_type: "skills",
              title: [],
              data_sources: [{ id: path.endsWith(db) ? ds : targetDs, name: "fixture" }],
            }
          if (path === `v1/data_sources/${ds}`)
            return {
              id: ds,
              parent: { database_id: db },
              title: [],
              properties: Object.fromEntries(
                Object.entries(props).map(([name, value]) => [
                  name,
                  { id: name === "Name" ? "title" : name, type: property(value).type },
                ]),
              ),
            }
          if (path === `v1/data_sources/${ds}/query`)
            return { results: [...rows.values()], has_more: false, next_cursor: null }
          if (path === `v1/data_sources/${targetDs}/query`)
            return { results: [], has_more: false, next_cursor: null }
          if (path.startsWith("v1/blocks/") && path.includes("/children"))
            return {
              results: children.get(path.split("/")[2]!) ?? [],
              has_more: false,
              next_cursor: null,
            }
          if (path === "v1/pages" || (path === `v1/pages/${sub}` && options?.method === "PATCH")) {
            const loss = lostWrite
            lostWrite = undefined
            if (loss && !loss.apply)
              throw Object.assign(new Error("Controlled lost write acknowledgement"), {
                code: "WRITE_OUTCOME_UNKNOWN",
              })
            for (const [key, raw] of Object.entries(property(property(body).properties))) {
              const name = key === "title" ? "Name" : key,
                p = property(raw),
                type = Object.keys(p)[0]!
              const values = p[type]
              props[name] = {
                ...(name === "Name" ? { id: "title" } : {}),
                type,
                ...p,
                ...(Array.isArray(values)
                  ? {
                      [type]: values.map((part: unknown) => ({
                        plain_text: String(property(property(part).text).content ?? ""),
                      })),
                    }
                  : {}),
              }
            }
            if (Array.isArray(property(body).children))
              children.set(sub, structuredClone(property(body).children as unknown[]))
            if (typeof property(body).in_trash === "boolean")
              removed = property(body).in_trash as boolean
            revision++
            rows.set(sub, row())
            if (loss)
              throw Object.assign(new Error("Controlled lost write acknowledgement"), {
                code: "WRITE_OUTCOME_UNKNOWN",
              })
            return row()
          }
          if (path === `v1/pages/${sub}`) return row()
          if (path === `v1/pages/${bad}`) return rows.get(bad)
          throw new Error(`Unexpected metadata request: ${path}`)
        },
        catch: (error) => {
          const value = error as { code?: string; message?: string }
          return fail(value.code ?? "UNEXPECTED", value.message ?? "Controlled metadata error")
        },
      }),
  })
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* Store
          yield* store.writeJson("config.json", {
            upstream_database: db,
            sources: [
              {
                alias: "controlled",
                database_id: target,
                data_source_ids: [targetDs],
                title: "Controlled",
                role: "content",
              },
            ],
          })
          yield* operation({
            requests,
            props,
            rows,
            children,
            bodies,
            failNext: (path, code = "ACCESS_DENIED") => {
              failure = { path, code }
            },
            loseNextWrite: (apply) => {
              lostWrite = { apply }
            },
            respond: (handler) => {
              response = handler
            },
            editExternally: (values, archived) => {
              Object.assign(props, values)
              if (archived !== undefined) removed = archived
              revision++
              rows.set(sub, row())
            },
            deny: (value) => {
              denied = value
            },
          }).pipe(
            Effect.provideService(Notion, notion),
            Effect.provideService(UpstreamState, store.upstream),
          )
        }),
      ).pipe(
        Effect.provide(StoreLive),
        Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerFetch)),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
      ),
    )
  } finally {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
}

test("invalid subscription names fail before metadata or journal writes for add and update", async () => {
  await boundary(({ requests }) =>
    Effect.gen(function* () {
      for (const name of ["", " ", "Source\u00002", "Source\t2", "Source\n2", "Source\u007f2"]) {
        expect(yield* addSubscription({ ...input, name }).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { code: "INVALID_SKILL_NAME" },
        })
        expect(
          yield* updateSubscription(sub, "unused", { ...input, name }).pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure", failure: { code: "INVALID_SKILL_NAME" } })
      }
      expect(requests).toEqual([])
      expect(yield* (yield* UpstreamState).command("unused")).toBeUndefined()
    }),
  )
})

test("subscription add and update preserve real names and stable page identity", async () => {
  await boundary(() =>
    Effect.gen(function* () {
      let current = yield* addSubscription({ ...input, name: "Tty7" })
      expect(current.name).toBe("Tty7")
      expect(current.subscription_id).toBe(sub)
      current = yield* publishSubscriptionMembers(sub, current.version, published, "verified")
      for (const name of ["n8n-workflow", "React19", "中文", "two  spaces", "name@scope/ref"]) {
        current = yield* updateSubscription(sub, current.version, { ...input, name })
        expect(current.name).toBe(name)
        expect(current.subscription_id).toBe(sub)
      }
    }),
  )
})

test("source URL follows the configured provider and clears when switching to a local Git source", async () => {
  await boundary(({ props }) =>
    Effect.gen(function* () {
      let current = yield* addSubscription({
        ...input,
        source: {
          provider: { type: "git", url: "https://github.com/example/first.git", ref: "main" },
        },
      })
      expect(current.source_url).toBe("https://github.com/example/first")
      current = yield* updateSubscription(sub, current.version, {
        ...input,
        source: {
          provider: { type: "git", url: "git@github.com:example/second.git", ref: "main" },
        },
      })
      expect(current.source_url).toBe("https://github.com/example/second")
      current = yield* updateSubscription(sub, current.version, {
        ...input,
        source: {
          provider: {
            type: "registry",
            base_url: "https://clawhub.ai",
            owner: "example",
            slug: "skill",
          },
        },
      })
      expect(current.source_url).toBe("https://clawhub.ai/example/skills/skill")
      current = yield* updateSubscription(sub, current.version, input)
      expect(current.source_url).toBeNull()
      expect(property(props["Source URL"]).url).toBeNull()
    }),
  )
})

test("a complete map between 180k and 200k characters publishes within native rich-text limits", async () => {
  await boundary(({ respond }) =>
    Effect.gen(function* () {
      const current = yield* addSubscription(input)
      const map = {
        ...published,
        members: Array.from({ length: 650 }, (_, index) => ({
          member_key: `skills/${String(index).padStart(4, "0")}/${"source-member".repeat(6)}`,
          page_id: `77777777-7777-4777-8777-${String(index).padStart(12, "0")}`,
          content_hash: "b".repeat(64),
          revision: "c".repeat(40),
        })),
      }
      const encoded = JSON.stringify(map)
      expect(encoded.length).toBeGreaterThan(180000)
      expect(encoded.length).toBeLessThanOrEqual(200000)
      respond((path, body) => {
        if (path !== `v1/pages/${sub}` || body === undefined) return
        const spans = property(property(property(body).properties)["Published Members"]).rich_text
        if (
          !Array.isArray(spans) ||
          spans.length > 100 ||
          spans.some((span) => String(property(property(span).text).content).length > 2000)
        )
          throw fail("NOTION_REQUEST_FAILED", "Native rich-text limits exceeded.")
      })
      const saved = yield* publishSubscriptionMembers(sub, current.version, map, "partial")
      expect(saved.published).toEqual(map)
      expect(saved.status).toBe("partial")
    }),
  )
})

test("published member readback accepts schema key order differing from serialized map", async () => {
  await boundary(({ props, respond }) =>
    Effect.gen(function* () {
      const current = yield* addSubscription(input)
      const alpha = "77777777-7777-4777-8777-777777777777"
      const beta = "88888888-8888-4888-8888-888888888888"
      const map = {
        version: 1 as const,
        revision: "fixed",
        plan_hash: "a".repeat(64),
        publisher_subscription_id: sub,
        members: [
          {
            member_key: "skills/alpha",
            page_id: alpha,
            content_hash: "b".repeat(64),
            revision: "c".repeat(40),
          },
          { member_key: "skills/beta", page_id: beta, content_hash: "d".repeat(64) },
        ],
      }
      respond((path, body) => {
        if (path !== `v1/pages/${sub}` || body !== undefined) return
        const spans = property(props["Published Members"]).rich_text
        if (!Array.isArray(spans)) return
        if (!spans.length) return
        const parsed = JSON.parse(spans.map((span) => String(property(span).plain_text)).join(""))
        const reorder = (value: Record<string, unknown>) =>
          Object.fromEntries([
            ["publisher_subscription_id", value.publisher_subscription_id],
            [
              "members",
              (value.members as Record<string, unknown>[]).map((member) => ({
                page_id: member.page_id,
                content_hash: member.content_hash,
                member_key: member.member_key,
                ...(member.revision === undefined ? {} : { revision: member.revision }),
              })),
            ],
            ["plan_hash", value.plan_hash],
            ["revision", value.revision],
            ["version", value.version],
          ])
        props["Published Members"] = rich(JSON.stringify(reorder(parsed)))
      })
      const saved = yield* publishSubscriptionMembers(sub, current.version, map, "partial")
      expect(saved.published).toEqual(map)
      expect(saved.published?.members).toEqual(map.members)
      expect(saved.status).toBe("partial")
      const echoedSpans = property(props["Published Members"]).rich_text as { plain_text: string }[]
      const echoed = JSON.parse(echoedSpans.map((span) => span.plain_text).join(""))
      expect(echoed.members).toEqual(map.members)
    }),
  )
})

test("subscription add and published map retire scoped negative directories and exact refs ignore cached absence", async () => {
  await boundary(({ requests, props, rows, deny, respond }) =>
    Effect.gen(function* () {
      const store = yield* Store
      const empty = yield* catalog({ database: target })
      expect(empty.records).toEqual([])
      const key = (yield* store.listKeys(`cache/catalogs/${empty.scope}`))[0]!
      expect(key).toBeDefined()
      const added = yield* addSubscription(input)
      expect(yield* store.readJson(key, CatalogSchema)).toBeUndefined()
      yield* catalog({ database: target })
      yield* publishSubscriptionMembers(sub, added.version, routedMembers, "verified")
      respond(routedQuery)
      expect(yield* store.readJson(key, CatalogSchema)).toBeUndefined()
      // Retain a fresh negative catalog to reproduce the original first-read failure.
      const selection = key.split("/")[3]!.replace(/\.json$/, "")
      const generation = yield* store.reserveCacheGeneration(empty.scope, `catalog-${selection}`)
      yield* store.writeJson(key, { ...empty, generation })
      requests.length = 0
      const first = yield* readSkill(`skill://upstream:${sub}/ROUTER.md`, { database: target })
      expect(first.source).toBe("notion")
      expect("content" in first ? first.content : undefined).toContain("## Members")
      requests.length = 0
      expect(
        (yield* readSkill(`skill://upstream:${sub}/ROUTER.md`, { database: target })).source,
      ).toBe("local_cache")
      expect(
        (yield* readSkill(`notion_subscription:${sub}`, { offline: true, database: target }))
          .snapshot_id,
      ).toBe(first.snapshot_id)
      expect(requests).toEqual([])
      expect(
        yield* readSkill(`upstream:${sub}`, { database: db }).pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { code: "SKILL_NOT_FOUND" } })
      expect(
        yield* readSkill(`upstream:${bad}`, { offline: true }).pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { code: "CACHE_MISSING" } })
      deny(true)
      expect(
        yield* readSkill(`upstream:${sub}`, { refresh: true }).pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { code: "ACCESS_DENIED" } })
      deny(false)
      rows.set(bad, {
        id: bad,
        parent: { database_id: db, data_source_id: ds },
        properties: { ...props, Name: rich("Historical\u00002", "title") },
      })
      const directory = yield* catalog({ database: target, refresh: true })
      expect(directory.records.map((record) => record.id).sort()).toEqual(
        [
          ...routedMembers.members.map((member) => `notion_page:${member.page_id}`),
          `notion_subscription:${sub}`,
        ].sort(),
      )
      expect(directory.coverage.failed_sources).toContainEqual(
        expect.objectContaining({ id: bad, code: "INVALID_SKILL_NAME", database_id: db }),
      )
      const cachedGeneration = yield* store.reserveCacheGeneration(
        first.scope,
        `catalog-${selection}`,
      )
      yield* store.writeJson(key, {
        ...directory,
        coverage: { ...directory.coverage, failed_sources: [] },
        records: directory.records
          .filter((record) => record.kind === "router")
          .map((record) => ({ ...record, name: "Cached Invalid 2" })),
        generation: cachedGeneration,
      })
      const cached = yield* catalog({ database: target, offline: true })
      expect(cached.records).toEqual([])
      expect(cached.coverage.failed_sources).toContainEqual(
        expect.objectContaining({ id: sub, code: "INVALID_SKILL_NAME" }),
      )
      expect(directory.coverage.exhaustive).toBe(false)
      expect(yield* authScope).toBe(first.scope)
    }),
  )
})

test("cold exact subscription refs validate online without directory discovery and reuse TTL observations", async () => {
  await boundary(({ props, requests, respond }) =>
    Effect.gen(function* () {
      props["Published Members"] = rich(JSON.stringify(routedMembers))
      respond(routedQuery)
      props.Status = { type: "select", select: { name: "verified" } }
      const first = yield* readSkill(`skill://upstream:${sub}/ROUTER.md`)
      expect(first.source).toBe("notion")
      expect(
        requests.some(
          (path) => path.includes("v1/search") || path === `POST v1/data_sources/${ds}/query`,
        ),
      ).toBe(false)
      requests.length = 0
      expect((yield* readSkill(`upstream:${sub}`)).snapshot_id).toBe(first.snapshot_id)
      expect(requests).toEqual([])
      expect(yield* readSkill(`upstream:${sub}`, { maxAge: 0 }).pipe(Effect.result)).toMatchObject({
        _tag: "Success",
        success: { source: "notion" },
      })
      expect(requests).toContain(`GET v1/pages/${sub}`)
      const currentApi = yield* Notion
      // A changed credential cannot reuse another identity's complete observation.
      expect(
        yield* readSkill(`upstream:${sub}`).pipe(
          Effect.provideService(Notion, {
            ...currentApi,
            credentialIdentity: Effect.succeed("different-credential"),
            request: (path, body, options) =>
              path === "v1/users/me"
                ? currentApi.request(path, body, options)
                : Effect.fail(fail("ACCESS_DENIED", "Different credential lacks access.")),
          }),
          Effect.result,
        ),
      ).toMatchObject({ _tag: "Failure", failure: { code: "ACCESS_DENIED" } })
    }),
  )
})

test.each([0, 1, 2])("exact Router needs multiple active Skills: %i published", async (count) => {
  await boundary(({ props, respond }) =>
    Effect.gen(function* () {
      props["Published Members"] = rich(
        JSON.stringify({ ...routedMembers, members: routedMembers.members.slice(0, count) }),
      )
      props.Status = { type: "select", select: { name: "verified" } }
      respond(routedQuery)
      const result = yield* readSkill(`upstream:${sub}`, { refresh: true }).pipe(Effect.result)
      if (count < 2) {
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            code: "UPSTREAM_ROUTER_UNAVAILABLE",
            details: { active_member_count: count, minimum_member_count: 2 },
          },
        })
      } else {
        expect(result._tag).toBe("Success")
        if (result._tag === "Success" && "content" in result.success) {
          expect(result.success.content).toContain(
            `skill://${routedMembers.members[0]!.page_id}/SKILL.md`,
          )
          expect(result.success.content).toContain(
            `skill://${routedMembers.members[1]!.page_id}/SKILL.md`,
          )
        }
      }
    }),
  )
})

test("old Router observations cannot bypass cardinality while pinned history stays readable", async () => {
  await boundary(({ props, requests, respond }) =>
    Effect.gen(function* () {
      props["Published Members"] = rich(JSON.stringify(routedMembers))
      props.Status = { type: "select", select: { name: "verified" } }
      respond(routedQuery)
      const first = yield* readSkill(`upstream:${sub}`)
      const store = yield* Store
      const keys = yield* store.listKeys(`cache/latest/${first.scope}/${first.record.id}`)
      const observation = (yield* store.readJson(keys[0]!, ObservationSchema))!
      const generation = yield* store.reserveCacheGeneration(first.scope, first.record.id)
      yield* store.writeJson(`cache/latest/${first.scope}/${first.record.id}/legacy-policy.json`, {
        ...observation,
        generation,
        materialization_version: "references-v5",
      })
      props["Published Members"] = rich(JSON.stringify(published))
      requests.length = 0
      expect(
        yield* readSkill(`upstream:${sub}`, { offline: true }).pipe(Effect.result),
      ).toMatchObject({
        _tag: "Failure",
        failure: { code: "CACHE_REFRESH_REQUIRED" },
      })
      expect(requests).toEqual([])
      expect(yield* readSkill(`upstream:${sub}`).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { code: "UPSTREAM_ROUTER_UNAVAILABLE" },
      })
      requests.length = 0
      const history = yield* readSkill(first.ref)
      expect("content" in history ? history.content : undefined).toBe(
        "content" in first ? first.content : undefined,
      )
      expect(requests).toEqual([])
    }),
  )
})

const savedCommand = (operationId: string) =>
  Effect.gen(function* () {
    const raw = yield* (yield* UpstreamState).command(operationId)
    expect(raw).toBeDefined()
    return strictDecode(UpstreamCommandOperationSchema, raw)
  })
const mutations = (requests: readonly string[]) =>
  requests.filter((request) => request === "POST v1/pages" || request.startsWith("PATCH "))

test.each(["same command", "operation resume"] as const)(
  "subscription GET preflight failure retries through %s with one original create POST",
  async (retry) => {
    await boundary(({ requests, failNext }) =>
      Effect.gen(function* () {
        const operationId = "ua_preflight_retry"
        failNext(`v1/data_sources/${ds}`)
        expect(yield* addSubscription(input, operationId).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { code: "ACCESS_DENIED" },
        })
        const preparing = yield* savedCommand(operationId)
        expect(preparing).toMatchObject({ operation_id: operationId, phase: "preparing" })
        expect(preparing.intent).toBeUndefined()
        expect(mutations(requests)).toEqual([])
        if (retry === "same command") {
          expect((yield* addSubscription(input, operationId)).subscription_id).toBe(sub)
        } else {
          yield* resumeSubscriptionCommand(preparing)
        }
        expect(yield* savedCommand(operationId)).toMatchObject({
          state: "verified",
          page_id: sub,
          intent: {
            method: "POST",
            path: "v1/pages",
            data_source_id: ds,
            target_database_id: target,
            correlation: `ntn-skills-upstream-operation:${operationId}`,
          },
        })
        yield* addSubscription(input, operationId)
        expect(mutations(requests)).toEqual(["POST v1/pages"])
        expect(
          (yield* (yield* UpstreamState).scopedCommands(yield* authScope)).map(
            (command) => command.operation_id,
          ),
        ).toEqual([operationId])
      }),
    )
  },
)

test("lost subscription create acknowledgement reconciles its original saved marker without another POST", async () => {
  await boundary(({ requests, bodies, children, loseNextWrite }) =>
    Effect.gen(function* () {
      const operationId = "ua_lost_acknowledgement"
      loseNextWrite(true)
      expect(yield* addSubscription(input, operationId).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { code: "WRITE_OUTCOME_UNKNOWN" },
      })
      const unknown = yield* savedCommand(operationId)
      expect(unknown).toMatchObject({ state: "unknown", phase: "mutation_intended" })
      expect(unknown.intent).toMatchObject({ method: "POST", path: "v1/pages" })
      const original = bodies.find((request) => request.path === "v1/pages")!
      expect(unknown.intent?.payload).toEqual(original.body)
      expect(children.get(sub)).toEqual([
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [
              { type: "text", text: { content: `ntn-skills-upstream-operation:${operationId}` } },
            ],
          },
        },
      ])
      requests.length = 0
      expect(yield* reconcileSubscriptionCommand(unknown)).toBe(true)
      expect(mutations(requests)).toEqual([])
      const verified = yield* savedCommand(operationId)
      expect(verified).toMatchObject({ state: "verified", page_id: sub })
      expect(yield* reconcileSubscriptionCommand(verified)).toBe(true)
      expect((yield* addSubscription(input, operationId)).subscription_id).toBe(sub)
      yield* resumeSubscriptionCommand(yield* savedCommand(operationId))
      expect(mutations(requests)).toEqual([])
      expect(bodies.filter((request) => request.path === "v1/pages")).toHaveLength(1)
    }),
  )
})

test.each(["candidate pagination", "marker pagination", "duplicate markers"] as const)(
  "subscription recovery blocks incomplete or ambiguous %s evidence without replay",
  async (scenario) => {
    await boundary(({ requests, rows, children, loseNextWrite, respond }) =>
      Effect.gen(function* () {
        const operationId = `ua_blocked_${scenario.replaceAll(" ", "_")}`
        loseNextWrite(true)
        yield* addSubscription(input, operationId).pipe(Effect.result)
        const unknown = yield* savedCommand(operationId)
        const created = rows.get(sub)!
        const marker = children.get(sub)!
        if (scenario === "candidate pagination") {
          respond((path) =>
            path === `v1/data_sources/${ds}/query`
              ? { results: [created], has_more: true, next_cursor: null }
              : undefined,
          )
        } else if (scenario === "marker pagination") {
          respond((path) =>
            path.startsWith(`v1/blocks/${sub}/children`)
              ? { results: marker, has_more: true, next_cursor: "repeated" }
              : undefined,
          )
        } else {
          const duplicate = { ...property(created), id: bad }
          children.set(bad, structuredClone(marker))
          respond((path, body) => {
            if (path !== `v1/data_sources/${ds}/query`) return undefined
            return property(body).start_cursor === "second"
              ? { results: [duplicate], has_more: false, next_cursor: null }
              : { results: [created], has_more: true, next_cursor: "second" }
          })
        }
        requests.length = 0
        const result = yield* reconcileSubscriptionCommand(unknown).pipe(Effect.result)
        if (result._tag === "Success") expect(result.success).toBe(false)
        expect((yield* savedCommand(operationId)).state).not.toBe("verified")
        expect(mutations(requests)).toEqual([])
        yield* addSubscription(input, operationId).pipe(Effect.result)
        yield* resumeSubscriptionCommand(yield* savedCommand(operationId)).pipe(Effect.result)
        expect((yield* savedCommand(operationId)).state).not.toBe("verified")
        expect(mutations(requests)).toEqual([])
      }),
    )
  },
)

test("subscription recovery accepts a unique marker only after exhausting candidate and child pages", async () => {
  await boundary(({ requests, rows, children, loseNextWrite, respond }) =>
    Effect.gen(function* () {
      const operationId = "ua_late_marker"
      loseNextWrite(true)
      yield* addSubscription(input, operationId).pipe(Effect.result)
      const marker = children.get(sub)!
      respond((path, body) => {
        if (path === `v1/data_sources/${ds}/query`)
          return property(body).start_cursor === "candidate-second"
            ? { results: [rows.get(sub)], has_more: false, next_cursor: null }
            : { results: [], has_more: true, next_cursor: "candidate-second" }
        if (path.startsWith(`v1/blocks/${sub}/children`))
          return path.includes("start_cursor=marker-second")
            ? { results: marker, has_more: false, next_cursor: null }
            : { results: [], has_more: true, next_cursor: "marker-second" }
        return undefined
      })
      requests.length = 0
      expect(yield* reconcileSubscriptionCommand(yield* savedCommand(operationId))).toBe(true)
      expect(requests).toContain(
        `GET v1/blocks/${sub}/children?page_size=100&start_cursor=marker-second`,
      )
      expect(mutations(requests)).toEqual([])
    }),
  )
})

test("subscription operation identity rejects a different credential or frozen target", async () => {
  await boundary(({ requests, loseNextWrite }) =>
    Effect.gen(function* () {
      const operationId = "ua_scoped_target"
      loseNextWrite(true)
      yield* addSubscription(input, operationId).pipe(Effect.result)
      const original = yield* savedCommand(operationId)
      requests.length = 0
      expect(
        yield* addSubscription({ ...input, target_database_id: bad }, operationId).pipe(
          Effect.result,
        ),
      ).toMatchObject({ _tag: "Failure", failure: { code: "UPSTREAM_OPERATION_MISMATCH" } })
      const api = yield* Notion
      const otherCredential = {
        ...api,
        credentialIdentity: Effect.succeed("other-subscription-credential"),
      }
      expect(
        yield* addSubscription(input, operationId).pipe(
          Effect.provideService(Notion, otherCredential),
          Effect.result,
        ),
      ).toMatchObject({ _tag: "Failure", failure: { code: "UPSTREAM_OPERATION_MISMATCH" } })
      const recovered = yield* reconcileSubscriptionCommand(original).pipe(
        Effect.provideService(Notion, otherCredential),
        Effect.result,
      )
      if (recovered._tag === "Success") expect(recovered.success).toBe(false)
      expect((yield* savedCommand(operationId)).state).not.toBe("verified")
      expect(mutations(requests)).toEqual([])
    }),
  )
})

test.each(["subscription_update", "subscription_remove"] as const)(
  "%s resumes an unknown unapplied mutation only at the original version and fences an external edit",
  async (domain) => {
    await boundary(({ requests, props, loseNextWrite, editExternally }) =>
      Effect.gen(function* () {
        const initial = yield* getSubscription(sub)
        const changed = { ...input, description: "Intended subscription update" }
        loseNextWrite(false)
        const failed = yield* (
          domain === "subscription_update"
            ? updateSubscription(sub, initial.version, changed).pipe(Effect.asVoid)
            : removeSubscription(sub, initial.version).pipe(Effect.asVoid)
        ).pipe(Effect.result)
        expect(failed).toMatchObject({
          _tag: "Failure",
          failure: { code: "WRITE_OUTCOME_UNKNOWN" },
        })
        const state = yield* UpstreamState
        const command = (yield* state.scopedCommands(yield* authScope)).find(
          (entry) => entry.domain === domain,
        )!
        expect(command).toMatchObject({
          domain,
          state: "unknown",
          intent: { method: "PATCH", path: `v1/pages/${sub}`, before_version: initial.version },
        })
        requests.length = 0
        expect(yield* reconcileSubscriptionCommand(command)).toBe(false)
        expect(mutations(requests)).toEqual([])
        const beforeDescription = props.Description
        editExternally({ Description: rich("External edit after unknown write") })
        const guarded = yield* resumeSubscriptionCommand(command).pipe(Effect.result)
        if (guarded._tag === "Success")
          expect((yield* savedCommand(command.operation_id)).state).not.toBe("verified")
        expect(props.Description).toEqual(rich("External edit after unknown write"))
        expect(mutations(requests)).toEqual([])
        // Restoring the visible values cannot restore the original version guard.
        editExternally({ Description: beforeDescription })
        yield* resumeSubscriptionCommand(yield* savedCommand(command.operation_id)).pipe(
          Effect.result,
        )
        expect(mutations(requests)).toEqual([])
      }),
    )
  },
)

test.each(["subscription_update", "subscription_remove"] as const)(
  "%s recovers the original unknown write at an unchanged before-version and repeats without mutation",
  async (domain) => {
    await boundary(({ requests, loseNextWrite }) =>
      Effect.gen(function* () {
        const initial = yield* getSubscription(sub)
        loseNextWrite(false)
        yield* (
          domain === "subscription_update"
            ? updateSubscription(sub, initial.version, {
                ...input,
                description: "Recovered update",
              }).pipe(Effect.asVoid)
            : removeSubscription(sub, initial.version).pipe(Effect.asVoid)
        ).pipe(Effect.result)
        const command = (yield* (yield* UpstreamState).scopedCommands(yield* authScope)).find(
          (entry) => entry.domain === domain,
        )!
        requests.length = 0
        yield* resumeSubscriptionCommand(command)
        expect((yield* savedCommand(command.operation_id)).state).toBe("verified")
        expect(mutations(requests)).toEqual([`PATCH v1/pages/${sub}`])
        requests.length = 0
        yield* resumeSubscriptionCommand(yield* savedCommand(command.operation_id))
        expect(yield* reconcileSubscriptionCommand(yield* savedCommand(command.operation_id))).toBe(
          true,
        )
        expect(mutations(requests)).toEqual([])
      }),
    )
  },
)

test("an exact create marker in another target configuration does not verify the frozen subscription", async () => {
  await boundary(({ requests, loseNextWrite, editExternally }) =>
    Effect.gen(function* () {
      const operationId = "ua_wrong_remote_target"
      loseNextWrite(true)
      yield* addSubscription(input, operationId).pipe(Effect.result)
      editExternally({ "Target Database ID": rich(bad) })
      requests.length = 0
      expect(yield* reconcileSubscriptionCommand(yield* savedCommand(operationId))).toBe(false)
      expect((yield* savedCommand(operationId)).state).not.toBe("verified")
      yield* addSubscription(input, operationId).pipe(Effect.result)
      yield* resumeSubscriptionCommand(yield* savedCommand(operationId)).pipe(Effect.result)
      expect(mutations(requests)).toEqual([])
    }),
  )
})

test.each([
  { legacyState: "running", marked: true },
  { legacyState: "unknown", marked: true },
  { legacyState: "running", marked: false },
  { legacyState: "unknown", marked: false },
] as const)(
  "legacy $legacyState subscription create uses read-only marker evidence (marked=$marked) without replay",
  async ({ legacyState, marked }) => {
    await boundary(({ requests, children, loseNextWrite }) =>
      Effect.gen(function* () {
        const operationId = `ua_legacy_${legacyState}`
        loseNextWrite(true)
        yield* addSubscription(input, operationId).pipe(Effect.result)
        const { intent: _intent, phase: _phase, ...prior } = yield* savedCommand(operationId)
        const state = yield* UpstreamState
        yield* state.saveCommand(operationId, { ...prior, state: legacyState })
        if (!marked) children.clear()
        requests.length = 0
        expect(yield* reconcileSubscriptionCommand(yield* savedCommand(operationId))).toBe(marked)
        yield* addSubscription(input, operationId).pipe(Effect.result)
        yield* resumeSubscriptionCommand(yield* savedCommand(operationId)).pipe(Effect.result)
        expect((yield* savedCommand(operationId)).state === "verified").toBe(marked)
        expect(mutations(requests)).toEqual([])
      }),
    )
  },
)

test.each(["subscription_update", "subscription_remove"] as const)(
  "%s verifies a remotely applied lost acknowledgement through read-only reconciliation",
  async (domain) => {
    await boundary(({ requests, loseNextWrite }) =>
      Effect.gen(function* () {
        const initial = yield* getSubscription(sub)
        loseNextWrite(true)
        expect(
          yield* (
            domain === "subscription_update"
              ? updateSubscription(sub, initial.version, {
                  ...input,
                  description: "Applied before acknowledgement loss",
                }).pipe(Effect.asVoid)
              : removeSubscription(sub, initial.version).pipe(Effect.asVoid)
          ).pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure", failure: { code: "WRITE_OUTCOME_UNKNOWN" } })
        const command = (yield* (yield* UpstreamState).scopedCommands(yield* authScope)).find(
          (entry) => entry.domain === domain,
        )!
        requests.length = 0
        expect(yield* reconcileSubscriptionCommand(command)).toBe(true)
        expect((yield* savedCommand(command.operation_id)).state).toBe("verified")
        yield* resumeSubscriptionCommand(yield* savedCommand(command.operation_id))
        expect(mutations(requests)).toEqual([])
      }),
    )
  },
)

test.each(["unchanged", "external edit"] as const)(
  "explicit subscription adoption reviews exact creation evidence and fences %s",
  async (scenario) => {
    await boundary(({ requests, children, loseNextWrite, editExternally }) =>
      Effect.gen(function* () {
        const operationId = "ua_explicit_adoption"
        loseNextWrite(true)
        yield* addSubscription(input, operationId).pipe(Effect.result)
        const original = yield* savedCommand(operationId)
        if (original.domain !== "subscription_add") throw new Error("Expected subscription add")
        const { intent: _intent, phase: _phase, ...legacy } = original
        yield* (yield* UpstreamState).saveCommand(operationId, legacy)
        children.clear()
        requests.length = 0
        const evidence = {
          operation_id: operationId,
          scope: original.scope,
          database_id: db,
          data_source_id: ds,
          target_database_id: target,
          source_config_hash: original.input_hash,
          page_id: sub,
          created_time: "2026-10-18T00:00:00.000Z",
          creation_evidence: "fixture-audit://original-create-request",
        }
        for (const invalid of [
          { ...evidence, scope: "wrong-scope" },
          { ...evidence, data_source_id: bad },
          { ...evidence, target_database_id: bad },
          { ...evidence, source_config_hash: "0".repeat(64) },
          { ...evidence, created_time: "2020-01-01T00:00:00.000Z" },
          { ...evidence, creation_evidence: "" },
        ]) {
          expect(yield* planSubscriptionAdoption(invalid).pipe(Effect.result)).toMatchObject({
            _tag: "Failure",
            failure: { code: "UPSTREAM_OPERATION_MISMATCH" },
          })
        }
        const plan = yield* planSubscriptionAdoption(evidence)
        expect(plan).toMatchObject({ operation_id: operationId, remote_writes: 0, evidence })
        expect((yield* savedCommand(operationId)).state).not.toBe("verified")
        expect(
          yield* applySubscriptionAdoption(operationId, "0".repeat(64)).pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure", failure: { code: "UPSTREAM_OPERATION_MISMATCH" } })
        if (scenario === "external edit") {
          // Even unchanged visible input cannot bypass the page-version evidence.
          editExternally({})
          expect(
            yield* applySubscriptionAdoption(operationId, plan.plan_hash).pipe(Effect.result),
          ).toMatchObject({ _tag: "Failure", failure: { code: "UPSTREAM_PLAN_STALE" } })
          expect((yield* savedCommand(operationId)).state).not.toBe("verified")
        } else {
          expect(yield* applySubscriptionAdoption(operationId, plan.plan_hash)).toMatchObject({
            operation_id: operationId,
            page_id: sub,
            verified: true,
            remote_writes: 0,
          })
          expect(yield* savedCommand(operationId)).toMatchObject({
            state: "verified",
            page_id: sub,
            adoption: { applied: true, plan_hash: plan.plan_hash },
          })
          expect((yield* addSubscription(input, operationId)).subscription_id).toBe(sub)
        }
        expect(mutations(requests)).toEqual([])
      }),
    )
  },
)
