import { randomUUID } from "node:crypto"
import { mkdtemp, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { IncomingMessage, ServerResponse } from "node:http"
import { expect, test } from "vitest"
import { contentSearch, mcpLogout } from "../../cli/src/sdk.ts"
import { property, SkillsError } from "../src/model.ts"
import { McpCredentialStore } from "../src/notion-mcp-credential-store.ts"
import { LIBRARY_MARKER } from "../src/shared-library-model.ts"
import { nativeGraphFixture } from "./graph-prepare-live-fixture.ts"
import { fixtureToken, json, localServer } from "./notion-http-fixture.ts"

const { startSdkSourceFixture } = await import(
  new URL("../../../scripts/sdk-source-fixture.mjs", import.meta.url).href
)
const workspaceId = "11111111-2222-4333-8444-555555555555"
const otherWorkspaceId = "99999999-2222-4333-8444-555555555555"
const principalId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
const privateText = "UNADMITTED_REMOTE_CONTENT"
const query = "body-only-owned-fixture"
type JsonObject = Record<string, unknown>
type McpCall = { readonly method: string; readonly name?: string; readonly args: JsonObject }
type McpState = {
  calls: McpCall[]
  results: readonly JsonObject[]
  notices: readonly unknown[]
  entryId: string
  workspaceId: string
  acceptedBearer: string
  searches: number
  fetches: number
  refreshes: number
  rejectSearches: number
  beforeSelf?: () => void | Promise<void>
  beforeFetch?: () => void | Promise<void>
  beforeSearch?: () => void | Promise<void>
  beforeRefresh?: () => void | Promise<void>
}
const tools = [
  {
    name: "notion-get-self",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "notion-fetch",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "notion-search",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        query_type: { type: "string", enum: ["internal", "user"] },
        page_size: { type: "integer", minimum: 1, maximum: 50 },
        max_highlight_length: { type: "integer", minimum: 0, maximum: 500 },
        page_url: { type: "string" },
      },
      required: ["query"],
    },
  },
]
function latch() {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function body(request: IncomingMessage): Promise<string> {
  const parts: Buffer[] = []
  for await (const part of request) parts.push(Buffer.from(part))
  return Buffer.concat(parts).toString("utf8")
}
function hit(id: string, title = "Owned result", highlight = query): JsonObject {
  return {
    id,
    title,
    highlight,
    type: "page",
    url: `https://app.notion.com/p/${id.replaceAll("-", "")}?pvs=204`,
    timestamp: "2026-11-23T05:12:00.000Z",
    path: privateText,
    verification: { state: "unverified" },
  }
}
async function failure(promise: Promise<unknown>, codes: readonly string[]): Promise<void> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(SkillsError)
    if (!(error instanceof SkillsError)) throw error
    expect(codes).toContain(error.code)
    expect(JSON.stringify(error)).not.toContain(fixtureToken)
    expect(JSON.stringify(error)).not.toContain(privateText)
    return
  }
  throw new Error("Expected the public search to reject")
}

async function controlled<A>(
  run: (fixture: {
    readonly root: string
    readonly source: Awaited<ReturnType<typeof startSdkSourceFixture>>
    readonly f: ReturnType<typeof nativeGraphFixture>
    readonly mcp: McpState
    readonly rest: { denied: boolean; workspaceId: string; calls: string[] }
    readonly options: {
      env: Record<string, string>
      database: string
      serverUrl: string
    }
    readonly seedGrant: (workspace?: string) => Promise<void>
  }) => Promise<A>,
  seed = true,
): Promise<A> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "sdk-mcp-search-"))
  const f = nativeGraphFixture({ width: 1, filesPerSkill: 1 })
  const library = f.descriptor
  const source = await startSdkSourceFixture(
    {
      notion: {
        library,
        database: {
          object: "database",
          id: library.skills.database_id,
          database_type: null,
          title: [{ plain_text: "Owned MCP search fixture" }],
          description: [{ plain_text: LIBRARY_MARKER + JSON.stringify(library) }],
          data_sources: [{ id: library.skills.data_source_id, name: "Skills" }],
        },
        main: structuredClone(f.pages[0]),
        skills: structuredClone(f.pages),
        files: structuredClone(f.files),
        records: [],
        sources: [],
        bodies: { ...Object.fromEntries(f.bodies), [f.pageIds[0]!]: `# Owned source\n${query}\n` },
      },
    },
    join(root, "requests.jsonl"),
  )
  const rest: { denied: boolean; workspaceId: string; calls: string[] } = {
    denied: false,
    workspaceId,
    calls: [],
  }
  const mcp: McpState = {
    calls: [],
    results: [hit(f.pageIds[0]!)],
    notices: [],
    entryId: library.skills.database_id,
    workspaceId,
    acceptedBearer: fixtureToken,
    searches: 0,
    fetches: 0,
    refreshes: 0,
    rejectSearches: 0,
  }
  const failures: unknown[] = []
  const failed = (error: unknown, response: ServerResponse) => {
    if (response.destroyed) return
    failures.push(error)
    json(response, 500, { error: "controlled_sdk_fixture_failed" })
  }
  try {
    return await localServer(
      (request, response) => {
        void (async () => {
          const path = request.url ?? "/"
          rest.calls.push(path)
          expect(request.headers.authorization).toBe("Bearer owned_sdk_rest_token")
          if (path === "/v1/users/me") {
            json(
              response,
              rest.denied ? 401 : 200,
              rest.denied
                ? {
                    object: "error",
                    status: 401,
                    code: "unauthorized",
                    message: "Owned REST authorization was rejected.",
                  }
                : { object: "user", id: principalId, bot: { workspace_id: rest.workspaceId } },
            )
            return
          }
          const input = await body(request)
          const controller = new AbortController()
          response.once("close", () => controller.abort())
          const upstream = await fetch(new URL(path, source.origin), {
            method: request.method,
            headers: { "content-type": "application/json" },
            ...(input ? { body: input } : {}),
            signal: controller.signal,
          })
          const text = await upstream.text()
          response.writeHead(upstream.status, { "content-type": "application/json" })
          response.end(text)
        })().catch((error: unknown) => failed(error, response))
      },
      (restOrigin) =>
        localServer(
          (request, response) => {
            void (async () => {
              if (request.url === "/token") {
                mcp.refreshes++
                const form = new URLSearchParams(await body(request))
                expect(form.get("grant_type")).toBe("refresh_token")
                await mcp.beforeRefresh?.()
                mcp.acceptedBearer = `owned_rotated_access_${mcp.refreshes}`
                json(response, 200, {
                  access_token: mcp.acceptedBearer,
                  refresh_token: `owned_rotated_refresh_${mcp.refreshes}`,
                  token_type: "Bearer",
                  expires_in: 3600,
                  scope: "default",
                })
                return
              }
              if (request.url !== "/mcp") throw new Error("Unexpected OAuth or MCP endpoint")
              const rpc = property(JSON.parse(await body(request)))
              if (typeof rpc.method !== "string") throw new Error("Expected an RPC method")
              const params = property(rpc.params)
              const name = typeof params.name === "string" ? params.name : undefined
              mcp.calls.push({ method: rpc.method, name, args: property(params.arguments) })
              if (request.headers.authorization !== "Bearer " + mcp.acceptedBearer) {
                json(response, 401, { error: privateText })
                return
              }
              const reply = (payload: JsonObject) =>
                json(response, 200, {
                  jsonrpc: "2.0",
                  id: rpc.id,
                  result: { resultType: "complete", ...payload },
                })
              if (rpc.method === "tools/list") {
                reply({ tools })
                return
              }
              if (rpc.method !== "tools/call") throw new Error("Unexpected RPC method")
              if (name === "notion-get-self") {
                await mcp.beforeSelf?.()
                reply({
                  structuredContent: {
                    workspace: { id: mcp.workspaceId, name: "Owned workspace" },
                    user: { id: principalId, name: "Fixture user", type: "person" },
                  },
                })
              } else if (name === "notion-fetch") {
                mcp.fetches++
                expect(property(params.arguments).id).toBe(library.skills.database_id)
                await mcp.beforeFetch?.()
                if (response.destroyed) return
                reply({
                  structuredContent: {
                    metadata: { type: "database" },
                    title: privateText,
                    text: privateText,
                    url: `https://app.notion.com/p/${mcp.entryId.replaceAll("-", "")}?pvs=204`,
                  },
                })
              } else if (name === "notion-search") {
                mcp.searches++
                await mcp.beforeSearch?.()
                if (response.destroyed) return
                if (mcp.rejectSearches > 0) {
                  mcp.rejectSearches--
                  json(response, 401, { error: privateText })
                } else
                  reply({
                    structuredContent: {
                      type: "workspace_search",
                      results: mcp.results,
                      ...(mcp.notices.length ? { notices: mcp.notices } : {}),
                    },
                  })
              } else throw new Error("Unexpected MCP tool")
            })().catch((error: unknown) => failed(error, response))
          },
          async (mcpOrigin) => {
            const options = {
              env: {
                NOTION_API_TOKEN: "owned_sdk_rest_token",
                NOTION_API_BASE_URL: restOrigin,
                NTN_SKILLS_HOME: join(root, "state"),
                NTN_SKILLS_CONFIG_HOME: join(root, "config"),
                NTN_SKILLS_CACHE_HOME: join(root, "cache"),
                NTN_SKILLS_SCHEDULER_ROOT: join(root, "scheduler"),
                NTN_SKILLS_NOTION_INTERVAL_MS: "100",
              },
              database: library.skills.database_id,
              serverUrl: mcpOrigin + "/mcp",
            }
            const seedGrant = async (workspace = workspaceId) => {
              const store = new McpCredentialStore({
                configHome: options.env.NTN_SKILLS_CONFIG_HOME,
                profile: "default",
                serverUrl: options.serverUrl,
                deadline: Date.now() + 15_000,
              })
              await store.transaction(async (state, commit) =>
                commit({
                  ...state,
                  revision: state.revision + 1,
                  grantEpoch: randomUUID(),
                  storedToken: null,
                  registration: {
                    issuer: mcpOrigin,
                    clientId: "owned_fixture_client",
                    authorizationEndpoint: mcpOrigin + "/authorize",
                    tokenEndpoint: mcpOrigin + "/token",
                    redirectUri: "http://127.0.0.1:65001/callback",
                    scope: "default",
                  },
                  oauth: {
                    kind: "ready",
                    accessToken: fixtureToken,
                    refreshToken: "owned_fixture_refresh",
                    expiresAt: Date.now() + 3_600_000,
                    scope: "default",
                    identity: { workspaceId: workspace, principalId },
                    refresh: { kind: "idle" },
                  },
                }),
              )
              mcp.acceptedBearer = fixtureToken
            }
            if (seed) await seedGrant()
            return run({ root, source, f, mcp, rest, options, seedGrant })
          },
        ),
    )
  } finally {
    await source.close()
    expect(failures).toEqual([])
    expect(source.unexpected).toEqual([])
    expect(
      source.requests.filter(
        (row: { method: string; path: string }) =>
          row.method !== "GET" && !row.path.endsWith("/query"),
      ),
    ).toEqual([])
    console.info(JSON.stringify({ mcpSearchSdkEvidence: root }))
  }
}

test("public content search stops at failed REST preflight before any MCP or authorization", async () => {
  await controlled(async (c) => {
    c.rest.denied = true
    let presented = 0
    await failure(
      contentSearch(
        { query },
        {
          ...c.options,
          onAuthorize: async () => {
            presented++
          },
        },
      ),
      ["AUTH_REQUIRED"],
    )
    expect(c.rest.calls).toContain("/v1/users/me")
    expect(c.mcp.calls).toEqual([])
    expect(presented).toBe(0)
  }, false)
})

test("public noninteractive search reports missing MCP authorization without starting it", async () => {
  await controlled(async (c) => {
    await failure(contentSearch({ query }, c.options), ["MCP_AUTH_REQUIRED"])
    expect(c.mcp.calls).toEqual([])
    expect(c.mcp.refreshes).toBe(0)
  }, false)
})

test("an invalid explicit MCP token cannot fall through to the cached OAuth grant", async () => {
  await controlled(async (c) => {
    let presented = 0
    await failure(
      contentSearch(
        { query },
        {
          ...c.options,
          env: { ...c.options.env, NOTION_MCP_TOKEN: "owned_invalid_explicit_token" },
          onAuthorize: async () => {
            presented++
          },
        },
      ),
      ["MCP_AUTH_INVALID_TOKEN"],
    )
    expect(c.mcp.calls).toHaveLength(1)
    expect(c.mcp.searches).toBe(0)
    expect(c.mcp.fetches).toBe(0)
    expect(c.mcp.refreshes).toBe(0)
    expect(presented).toBe(0)
  })
})

test("a known workspace mismatch stops before entry verification or sending the query", async () => {
  await controlled(async (c) => {
    await c.seedGrant(otherWorkspaceId)
    await failure(contentSearch({ query }, c.options), ["MCP_SOURCE_UNAVAILABLE"])
    expect(c.mcp.calls).toEqual([])
  })
})

test("the selected physical entry must be readable by MCP before the query is sent", async () => {
  await controlled(async (c) => {
    c.mcp.entryId = c.f.pageIds[0]!
    await failure(contentSearch({ query }, c.options), ["MCP_UNSUPPORTED"])
    expect(c.mcp.fetches).toBe(1)
    expect(c.mcp.searches).toBe(0)
  })
})

test("public body search admits Enabled owners outside Default Context and withholds disabled hits", async () => {
  await controlled(async (c) => {
    const disabled = c.source.notion.skills[1]
    property(disabled.properties).enabled = { id: "enabled", type: "checkbox", checkbox: false }
    c.mcp.results = [hit(c.f.pageIds[0]!), hit(c.f.pageIds[1]!, privateText, privateText)]
    c.mcp.notices = [{ message: privateText, secret: fixtureToken }]
    const result = await contentSearch({ query, limit: 10 }, c.options)
    expect(result).toMatchObject({
      kind: "results",
      coverage: "remote_non_exhaustive",
      exhaustive: false,
      partial: true,
    })
    expect(result.records).toHaveLength(1)
    expect(result.records[0]).toMatchObject({
      enabled: true,
      default_context: false,
      locator: { page_id: c.f.pageIds[0] },
      match: { pageId: c.f.pageIds[0], snippet: query, representation: "native" },
    })
    const sent = c.mcp.calls.find((call) => call.name === "notion-search")
    expect(sent?.args).toEqual({
      query,
      query_type: "internal",
      page_size: 10,
      max_highlight_length: 350,
      page_url: `https://www.notion.so/${c.f.descriptor.parent_page_id.replaceAll("-", "")}`,
    })
    expect(c.mcp.calls.filter((call) => call.name).map((call) => call.name)).toEqual([
      "notion-fetch",
      "notion-search",
    ])
    expect(JSON.stringify(result)).not.toContain(privateText)
    expect(JSON.stringify(result)).not.toContain(fixtureToken)
    expect(
      c.source.requests.filter((row: { path: string }) => row.path.endsWith("/markdown")),
    ).toEqual([])
  })
})

test("an empty public remote result remains explicitly non-exhaustive without a REST title fallback", async () => {
  await controlled(async (c) => {
    c.mcp.results = []
    const result = await contentSearch({ query }, c.options)
    expect(result.records).toEqual([])
    expect(result.exhaustive).toBe(false)
    expect(result.coverage).toBe("remote_non_exhaustive")
    expect(result.notices.map((notice) => notice.code)).toContain("REMOTE_NON_EXHAUSTIVE")
    expect(c.mcp.searches).toBe(1)
    expect(c.rest.calls.some((path) => path === "/v1/search")).toBe(false)
    expect(
      c.source.requests.filter((row: { path: string }) => row.path.endsWith("/query")),
    ).toEqual([])
  })
})

test("logout during an in-flight query prevents the old grant from publishing its result", async () => {
  await controlled(async (c) => {
    c.mcp.beforeSearch = async () => {
      await mcpLogout(c.options)
    }
    await failure(contentSearch({ query }, c.options), ["MCP_AUTH_STALE"])
    expect(c.mcp.searches).toBe(1)
    expect(
      c.source.requests.some((row: { path: string }) => row.path === `/v1/pages/${c.f.pageIds[0]}`),
    ).toBe(false)
  })
})

test("a replacement grant observed after 401 cannot adopt the old search even in the same workspace", async () => {
  await controlled(async (c) => {
    c.mcp.rejectSearches = 1
    c.mcp.beforeSearch = async () => {
      await c.seedGrant()
    }
    await failure(contentSearch({ query }, c.options), ["MCP_SEARCH_STALE"])
    expect(c.mcp.searches).toBe(1)
    expect(c.mcp.refreshes).toBe(1)
  })
})

test("logout queued during refresh prevents a retry from publishing under the rotated credential", async () => {
  await controlled(async (c) => {
    const refreshReached = latch(),
      releaseRefresh = latch(),
      releaseFetch = latch()
    c.mcp.rejectSearches = 1
    c.mcp.beforeRefresh = async () => {
      refreshReached.resolve()
      await releaseRefresh.promise
    }
    c.mcp.beforeFetch = async () => {
      if (c.mcp.fetches > 1) await releaseFetch.promise
    }
    const pending = failure(contentSearch({ query }, c.options), [
      "MCP_AUTH_STALE",
      "MCP_SEARCH_STALE",
    ])
    try {
      await refreshReached.promise
      const logout = mcpLogout(c.options)
      releaseRefresh.resolve()
      await logout
      releaseFetch.resolve()
      await pending
      expect(c.mcp.searches).toBe(1)
      expect(c.mcp.refreshes).toBe(1)
    } finally {
      releaseRefresh.resolve()
      releaseFetch.resolve()
    }
  })
})

test("public search cancellation and expiry before preflight issue no HTTP requests", async () => {
  await controlled(async (c) => {
    const controller = new AbortController()
    controller.abort()
    await failure(contentSearch({ query }, { ...c.options, signal: controller.signal }), [
      "MCP_CANCELLED",
    ])
    await failure(contentSearch({ query }, { ...c.options, deadline: Date.now() - 1 }), [
      "MCP_TIMEOUT",
    ])
    expect(c.rest.calls).toEqual([])
    expect(c.mcp.calls).toEqual([])
  })
})

test.each(["cancel", "deadline"] as const)(
  "public search propagates %s to an in-flight MCP query",
  async (mode) => {
    await controlled(async (c) => {
      const reached = latch(),
        release = latch()
      c.mcp.beforeSearch = async () => {
        reached.resolve()
        await release.promise
      }
      const controller = new AbortController()
      const pending = failure(
        contentSearch(
          { query },
          {
            ...c.options,
            signal: controller.signal,
            deadline: Date.now() + (mode === "deadline" ? 3000 : 15_000),
          },
        ),
        [mode === "deadline" ? "MCP_TIMEOUT" : "MCP_CANCELLED"],
      )
      try {
        await reached.promise
        if (mode === "cancel") controller.abort()
        await pending
        expect(c.mcp.searches).toBe(1)
        expect(
          c.source.requests.some(
            (row: { path: string }) => row.path === `/v1/pages/${c.f.pageIds[0]}`,
          ),
        ).toBe(false)
      } finally {
        release.resolve()
      }
    })
  },
)
