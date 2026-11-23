import { expect, test } from "bun:test"
import type { IncomingMessage, ServerResponse } from "node:http"
import { SkillsError, property } from "../src/model.ts"
import {
  getNotionMcpIdentity,
  NOTION_MCP_PROTOCOL_VERSION,
  searchNotionMcp,
  verifyNotionMcpSource,
} from "../src/notion-mcp-client.ts"
import { fixtureToken, json, localServer } from "./notion-http-fixture.ts"

const workspaceId = "11111111-2222-4333-8444-555555555555"
const principalId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
const pageId = "dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb"
const identity = {
  workspace: { id: workspaceId, name: "Owned fixture" },
  user: { id: principalId, name: "Fixture user", type: "person" },
}
const selfTool = {
  name: "notion-get-self",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
}
const fetchTool = {
  name: "notion-fetch",
  inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
}
const searchTool = {
  name: "notion-search",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", "x-mcp-header": "Query" },
      query_type: { type: "string", enum: ["internal", "user"] },
      page_size: { type: "integer", minimum: 1, maximum: 50 },
      max_highlight_length: { type: "integer", minimum: 0, maximum: 500 },
      page_url: { type: "string" },
      data_source_url: { type: "string" },
    },
    required: ["query"],
  },
}
type Rpc = ReturnType<typeof property>
const complete = (rpc: Rpc, result: Rpc) => ({
  jsonrpc: "2.0",
  id: rpc.id,
  result: { resultType: "complete", ...result },
})
const toolsResult = (tools: readonly unknown[], extra: Rpc = {}) => ({
  tools,
  ttlMs: 0,
  cacheScope: "private",
  ...extra,
})
const textResult = (value: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  isError: false,
})
// Same fields as the owned hosted fixture; no workspace IDs or content are copied.
const workspaceHit = {
  id: pageId,
  title: "Owned fixture title",
  url: "https://app.notion.com/p/" + pageId.replaceAll("-", "") + "?pvs=204",
  type: "page",
  highlight: "A **body-only** phrase in the owned fixture.",
  timestamp: "2026-11-23T05:12:00.000Z",
  path: "UNADMITTED_REMOTE_CONTENT",
  verification: { state: "unverified" },
  parent_data_source_url: "collection://" + workspaceId,
}

async function fixture<A>(
  handle: (rpc: Rpc, request: IncomingMessage, response: ServerResponse) => Promise<void> | void,
  use: (serverUrl: string) => Promise<A>,
): Promise<A> {
  const failures: unknown[] = []
  return localServer(
    (request, response) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        await handle(property(value), request, response)
      })().catch((error: unknown) => {
        failures.push(error)
        if (!response.headersSent) json(response, 500, { error: "fixture_failed" })
        else response.end()
      })
    },
    async (origin) => {
      const result = await use(origin + "/mcp")
      if (failures.length) throw failures[0]
      return result
    },
  )
}

async function rejected(promise: Promise<unknown>, code: string): Promise<SkillsError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(SkillsError)
    if (!(error instanceof SkillsError)) throw error
    expect(error.code).toBe(code)
    expect(JSON.stringify(error)).not.toContain(fixtureToken)
    expect(JSON.stringify(error)).not.toContain("UNADMITTED_REMOTE_CONTENT")
    return error
  }
  throw new Error("Expected the MCP boundary to reject the response")
}

test("MCP uses independent July POST requests and validates identity from JSON text", async () => {
  const requests: Array<{ rpc: Rpc; request: IncomingMessage }> = []
  await fixture(
    (rpc, request, response) => {
      requests.push({ rpc, request })
      json(
        response,
        200,
        complete(rpc, rpc.method === "tools/list" ? toolsResult([selfTool]) : textResult(identity)),
      )
    },
    async (serverUrl) => {
      expect(await getNotionMcpIdentity({ bearer: fixtureToken, serverUrl })).toEqual({
        workspaceId,
        principalId,
      })
    },
  )
  expect(requests.map(({ rpc }) => rpc.method)).toEqual(["tools/list", "tools/call"])
  for (const { rpc, request } of requests) {
    if (typeof rpc.method !== "string") throw new Error("Expected a string RPC method")
    expect(request.method).toBe("POST")
    expect(request.url).toBe("/mcp")
    expect(request.headers.authorization).toBe("Bearer " + fixtureToken)
    expect(request.headers["mcp-protocol-version"]).toBe(NOTION_MCP_PROTOCOL_VERSION)
    expect(request.headers["mcp-method"]).toBe(rpc.method)
    expect(request.headers.accept).toBe("application/json, text/event-stream")
    expect(request.headers["mcp-session-id"]).toBeUndefined()
    expect(request.headers["notion-version"]).toBeUndefined()
    expect(property(property(rpc.params)._meta)).toEqual({
      "io.modelcontextprotocol/protocolVersion": NOTION_MCP_PROTOCOL_VERSION,
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": { name: "notion-skills-cli", version: "1" },
    })
    expect(JSON.stringify(rpc)).not.toContain(fixtureToken)
  }
  expect(requests[1]?.request.headers["mcp-name"]).toBe("notion-get-self")
})

test("tool-list pagination accepts an empty cursor and obtains identity only after the full list", async () => {
  const cursors: unknown[] = []
  await fixture(
    (rpc, _request, response) => {
      const params = property(rpc.params)
      if (rpc.method === "tools/list") {
        cursors.push(params.cursor)
        json(
          response,
          200,
          complete(
            rpc,
            cursors.length === 1 ? toolsResult([], { nextCursor: "" }) : toolsResult([selfTool]),
          ),
        )
      } else json(response, 200, complete(rpc, { structuredContent: identity, isError: false }))
    },
    async (serverUrl) => {
      expect(await getNotionMcpIdentity({ bearer: fixtureToken, serverUrl })).toEqual({
        workspaceId,
        principalId,
      })
    },
  )
  expect(cursors).toEqual([undefined, ""])
})

test("repeated cursors and page/request/tool/byte budgets terminate the actual HTTP flow", async () => {
  for (const scenario of ["cursor", "pages", "requests", "tools", "bytes", "total-bytes"]) {
    let calls = 0
    await fixture(
      (rpc, _request, response) => {
        calls++
        const list =
          scenario === "cursor"
            ? toolsResult([], { nextCursor: "" })
            : scenario === "pages"
              ? toolsResult([], { nextCursor: String(calls) })
              : scenario === "tools"
                ? toolsResult([selfTool, fetchTool])
                : toolsResult([selfTool])
        json(
          response,
          200,
          complete(rpc, rpc.method === "tools/list" ? list : textResult(identity)),
        )
      },
      async (serverUrl) => {
        await rejected(
          getNotionMcpIdentity({
            bearer: fixtureToken,
            serverUrl,
            budgets: {
              ...(scenario === "pages" ? { maxListPages: 2 } : {}),
              ...(scenario === "requests" ? { maxRequests: 1 } : {}),
              ...(scenario === "tools" ? { maxTools: 1 } : {}),
              ...(scenario === "bytes" ? { maxResponseBytes: 16 } : {}),
              ...(scenario === "total-bytes" ? { maxTotalBytes: 16 } : {}),
            },
          }),
          scenario === "cursor" ? "MCP_INVALID_RESPONSE" : "MCP_BUDGET_EXCEEDED",
        )
      },
    )
    expect(calls).toBeLessThanOrEqual(2)
  }
})

test("request-scoped SSE accepts comments, CRLF, split UTF-8 and notifications, then cancels the stream", async () => {
  let closed = false
  await fixture(
    async (rpc, _request, response) => {
      if (rpc.method === "tools/list") {
        json(response, 200, complete(rpc, toolsResult([selfTool])))
        return
      }
      response.on("close", () => {
        closed = true
      })
      response.writeHead(200, { "content-type": "text/event-stream" })
      const notification = {
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { message: "测试" },
      }
      const payload =
        ": keepalive\r\ndata: " +
        JSON.stringify(notification) +
        "\r\n\r\n" +
        "event: message\r\ndata: " +
        JSON.stringify(complete(rpc, textResult(identity))) +
        "\r\n\r\n"
      const bytes = Buffer.from(payload)
      for (let offset = 0; offset < bytes.length; offset += 7) {
        response.write(bytes.subarray(offset, offset + 7))
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      // Intentionally keep the stream open: a final response must complete the client request.
    },
    async (serverUrl) => {
      expect(
        await getNotionMcpIdentity({
          bearer: fixtureToken,
          serverUrl,
          budgets: { attemptTimeoutMs: 1000 },
        }),
      ).toEqual({ workspaceId, principalId })
      for (let i = 0; i < 20 && !closed; i++)
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
      expect(closed).toBe(true)
    },
  )
})

test("SSE final events need a delimiter and IDs; notification count is bounded", async () => {
  for (const scenario of ["eof", "id", "events"]) {
    await fixture(
      (rpc, _request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" })
        if (scenario === "events") {
          const event =
            "data: " + JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" }) + "\n\n"
          response.end(event + event)
        } else {
          const value = complete(rpc, toolsResult([selfTool]))
          if (scenario === "id") value.id = 999
          response.end("data: " + JSON.stringify(value) + (scenario === "eof" ? "" : "\n\n"))
        }
      },
      async (serverUrl) => {
        await rejected(
          getNotionMcpIdentity({
            bearer: fixtureToken,
            serverUrl,
            budgets: { maxEvents: 1 },
          }),
          scenario === "events" ? "MCP_BUDGET_EXCEEDED" : "MCP_INVALID_RESPONSE",
        )
      },
    )
  }
})

test("HTTP cancellation and independent attempt timeout close a hanging body", async () => {
  for (const cancelled of [false, true]) {
    let closed = false
    const controller = new AbortController()
    await fixture(
      (_rpc, _request, response) => {
        response.on("close", () => {
          closed = true
        })
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.write(": waiting\n\n")
        if (cancelled) setTimeout(() => controller.abort("private cancellation reason"), 10)
      },
      async (serverUrl) => {
        await rejected(
          getNotionMcpIdentity({
            bearer: fixtureToken,
            serverUrl,
            signal: controller.signal,
            budgets: { attemptTimeoutMs: cancelled ? 500 : 100 },
          }),
          cancelled ? "MCP_CANCELLED" : "MCP_TIMEOUT",
        )
        for (let i = 0; i < 20 && !closed; i++)
          await new Promise<void>((resolve) => setTimeout(resolve, 5))
        expect(closed).toBe(true)
      },
    )
  }
})

test("expired or cancelled operations do not issue an HTTP request", async () => {
  let requests = 0
  await fixture(
    (_rpc, _request, response) => {
      requests++
      response.end()
    },
    async (serverUrl) => {
      await rejected(
        getNotionMcpIdentity({
          bearer: fixtureToken,
          serverUrl,
          deadline: Date.now() - 1,
        }),
        "MCP_TIMEOUT",
      )
      const controller = new AbortController()
      controller.abort()
      await rejected(
        getNotionMcpIdentity({
          bearer: fixtureToken,
          serverUrl,
          signal: controller.signal,
        }),
        "MCP_CANCELLED",
      )
    },
  )
  expect(requests).toBe(0)
})

test("authentication, permission and arbitrary tool errors never expose the remote body", async () => {
  for (const scenario of [401, 403, 200]) {
    let requests = 0
    await fixture(
      (rpc, _request, response) => {
        requests++
        const privateMessage = "UNADMITTED_REMOTE_CONTENT " + fixtureToken
        if (scenario !== 200) json(response, scenario, { message: privateMessage })
        else if (rpc.method === "tools/list")
          json(response, 200, complete(rpc, toolsResult([selfTool])))
        else
          json(
            response,
            200,
            complete(rpc, {
              isError: true,
              content: [{ type: "text", text: privateMessage }],
            }),
          )
      },
      async (serverUrl) => {
        await rejected(
          getNotionMcpIdentity({ bearer: fixtureToken, serverUrl }),
          scenario === 401
            ? "MCP_AUTH_REQUIRED"
            : scenario === 403
              ? "MCP_ACCESS_DENIED"
              : "MCP_UNAVAILABLE",
        )
      },
    )
    expect(requests).toBe(scenario === 200 ? 2 : 1)
  }
})

test("HTTP redirects are not followed with the bearer", async () => {
  let destinationRequests = 0
  await localServer(
    (_request, response) => {
      destinationRequests++
      response.end()
    },
    async (destination) => {
      await fixture(
        (_rpc, _request, response) => {
          response.writeHead(302, { location: destination + "/capture" })
          response.end()
        },
        async (serverUrl) => {
          await rejected(
            getNotionMcpIdentity({ bearer: fixtureToken, serverUrl }),
            "MCP_UNSUPPORTED",
          )
        },
      )
    },
  )
  expect(destinationRequests).toBe(0)
})

test("HTTP and tool rate limits each retry once within the shared request budget", async () => {
  for (const toolRate of [false, true]) {
    let attempts = 0
    await fixture(
      (rpc, _request, response) => {
        attempts++
        if (!toolRate && attempts === 1) {
          json(response, 429, { message: fixtureToken }, { "retry-after": "0" })
        } else if (rpc.method === "tools/list") {
          json(response, 200, complete(rpc, toolsResult([selfTool])))
        } else if (toolRate && attempts === 2) {
          json(
            response,
            200,
            complete(rpc, {
              isError: true,
              structuredContent: {
                error: { code: "rate_limited", retry_after_seconds: 0, message: fixtureToken },
              },
            }),
          )
        } else json(response, 200, complete(rpc, textResult(identity)))
      },
      async (serverUrl) => {
        expect(
          await getNotionMcpIdentity({
            bearer: fixtureToken,
            serverUrl,
            budgets: { maxRequests: 3 },
          }),
        ).toEqual({ workspaceId, principalId })
      },
    )
    expect(attempts).toBe(3)
  }
})

test("long retry delays, repeated rate limits and cancellation during retry remain bounded", async () => {
  for (const scenario of ["long", "repeated", "cancel"]) {
    let calls = 0
    const controller = new AbortController()
    await fixture(
      (_rpc, _request, response) => {
        calls++
        json(
          response,
          429,
          { message: fixtureToken },
          {
            "retry-after": scenario === "long" ? "100" : scenario === "cancel" ? "1" : "0",
          },
        )
        if (scenario === "cancel") setTimeout(() => controller.abort(), 10)
      },
      async (serverUrl) => {
        await rejected(
          getNotionMcpIdentity({
            bearer: fixtureToken,
            serverUrl,
            signal: controller.signal,
          }),
          scenario === "cancel" ? "MCP_CANCELLED" : "MCP_RATE_LIMITED",
        )
      },
    )
    expect(calls).toBe(scenario === "repeated" ? 2 : 1)
  }
})

test("unknown protocol, non-complete and legacy result envelopes do not degrade to another protocol", async () => {
  for (const scenario of ["version", "version-no-id", "legacy", "input"]) {
    let calls = 0
    await fixture(
      (rpc, _request, response) => {
        calls++
        const body = scenario.startsWith("version")
          ? {
              jsonrpc: "2.0",
              id: scenario === "version" ? rpc.id : null,
              error: { code: -32022, message: fixtureToken, data: { supported: ["2025-11-25"] } },
            }
          : {
              jsonrpc: "2.0",
              id: rpc.id,
              result:
                scenario === "legacy"
                  ? toolsResult([selfTool])
                  : { resultType: "input_required", inputRequests: { private: fixtureToken } },
            }
        json(response, scenario.startsWith("version") ? 400 : 200, body)
      },
      async (serverUrl) => {
        await rejected(getNotionMcpIdentity({ bearer: fixtureToken, serverUrl }), "MCP_UNSUPPORTED")
      },
    )
    expect(calls).toBe(1)
  }
})

test("malformed JSON, UTF-8, identity and response types fail at the boundary", async () => {
  for (const scenario of ["json", "utf8", "content-type", "identity"]) {
    await fixture(
      (rpc, _request, response) => {
        if (scenario === "identity" && rpc.method === "tools/list")
          json(response, 200, complete(rpc, toolsResult([selfTool])))
        else if (scenario === "identity")
          json(
            response,
            200,
            complete(rpc, textResult({ workspace: { id: fixtureToken }, user: {} })),
          )
        else {
          response.writeHead(200, {
            "content-type": scenario === "content-type" ? "text/html" : "application/json",
          })
          response.end(scenario === "utf8" ? Buffer.from([0xff]) : "UNADMITTED_REMOTE_CONTENT")
        }
      },
      async (serverUrl) => {
        await rejected(
          getNotionMcpIdentity({ bearer: fixtureToken, serverUrl }),
          "MCP_INVALID_RESPONSE",
        )
      },
    )
  }
})

test("invalid custom header definitions exclude that tool; other malformed tools do not block self", async () => {
  const malformed = {
    ...selfTool,
    inputSchema: {
      type: "object",
      properties: { invalid: { type: "array", items: { type: "string", "x-mcp-header": "bad" } } },
    },
  }
  for (const usable of [false, true]) {
    let calls = 0
    await fixture(
      (rpc, _request, response) => {
        calls++
        json(
          response,
          200,
          complete(
            rpc,
            rpc.method === "tools/list"
              ? toolsResult(
                  usable ? [{ ...malformed, name: "unrelated-tool" }, selfTool] : [malformed],
                )
              : textResult(identity),
          ),
        )
      },
      async (serverUrl) => {
        if (usable)
          expect(await getNotionMcpIdentity({ bearer: fixtureToken, serverUrl })).toEqual({
            workspaceId,
            principalId,
          })
        else
          await rejected(
            getNotionMcpIdentity({ bearer: fixtureToken, serverUrl }),
            "MCP_UNSUPPORTED",
          )
      },
    )
    expect(calls).toBe(usable ? 2 : 1)
  }
})

test("declared required parameters and missing scope filters reject before the search call", async () => {
  for (const scenario of ["required", "filter"]) {
    let calls = 0
    await fixture(
      (rpc, _request, response) => {
        calls++
        const schema =
          scenario === "required"
            ? { ...searchTool.inputSchema, required: ["query", "unknown_required"] }
            : { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
        json(response, 200, complete(rpc, toolsResult([{ ...searchTool, inputSchema: schema }])))
      },
      async (serverUrl) => {
        await rejected(
          searchNotionMcp({
            bearer: fixtureToken,
            serverUrl,
            query: "owned fixture",
            ...(scenario === "filter" ? { pageUrl: pageId } : {}),
          }),
          "MCP_UNSUPPORTED",
        )
      },
    )
    expect(calls).toBe(1)
  }
})

test("search mirrors declared headers and rejects unexpected result types without leaking matches", async () => {
  for (const query of ["正文", " padded ", "=?base64?literal?=", "line1\r\nline2"]) {
    let name: string | undefined
    let header: string | undefined
    let argumentsValue: Rpc = {}
    await fixture(
      (rpc, request, response) => {
        if (rpc.method === "tools/list")
          json(response, 200, complete(rpc, toolsResult([searchTool])))
        else {
          name =
            typeof request.headers["mcp-name"] === "string"
              ? request.headers["mcp-name"]
              : undefined
          header =
            typeof request.headers["mcp-param-query"] === "string"
              ? request.headers["mcp-param-query"]
              : undefined
          argumentsValue = property(property(rpc.params).arguments)
          json(
            response,
            200,
            complete(
              rpc,
              textResult({
                type: "ai_search",
                results: [{ title: "UNADMITTED_REMOTE_CONTENT", text: fixtureToken }],
              }),
            ),
          )
        }
      },
      async (serverUrl) => {
        await rejected(
          searchNotionMcp({
            bearer: fixtureToken,
            serverUrl,
            query,
            pageSize: 5,
            dataSourceUrl: "collection://" + pageId,
          }),
          "MCP_UNSUPPORTED",
        )
      },
    )
    expect(name).toBe("notion-search")
    expect(header).toBe("=?base64?" + Buffer.from(query).toString("base64") + "?=")
    expect(argumentsValue).toEqual({
      query,
      query_type: "internal",
      page_size: 5,
      max_highlight_length: 350,
      data_source_url: "collection://" + pageId,
    })
  }
})

test("standard hosted workspace search preserves only page matches and a fixed notice count", async () => {
  const payload = {
    type: "workspace_search",
    results: [workspaceHit],
    notices: [{ message: "UNADMITTED_REMOTE_CONTENT", credential: fixtureToken }],
  }
  await fixture(
    (rpc, _request, response) => {
      json(
        response,
        200,
        complete(
          rpc,
          rpc.method === "tools/list"
            ? toolsResult([searchTool])
            : { structuredContent: payload, content: [{ type: "text", text: fixtureToken }] },
        ),
      )
    },
    async (serverUrl) => {
      const result = await searchNotionMcp({ bearer: fixtureToken, serverUrl, query: "body-only" })
      expect(result).toEqual({
        matches: [
          {
            pageId,
            title: workspaceHit.title,
            snippet: workspaceHit.highlight,
            url: "https://www.notion.so/" + pageId.replaceAll("-", ""),
          },
        ],
        notices: [{ kind: "remote_notice", count: 1 }],
        exhaustive: false,
      })
      expect(JSON.stringify(result)).not.toContain("UNADMITTED_REMOTE_CONTENT")
      expect(JSON.stringify(result)).not.toContain(fixtureToken)
      expect(JSON.stringify(result)).not.toContain("collection://")
    },
  )
})

test("standard JSON text search supports omitted highlights and non-exhaustive empty results", async () => {
  for (const results of [[], [{ ...workspaceHit, highlight: undefined }]]) {
    await fixture(
      (rpc, _request, response) => {
        json(
          response,
          200,
          complete(
            rpc,
            rpc.method === "tools/list"
              ? toolsResult([searchTool])
              : textResult({ type: "workspace_search", results }),
          ),
        )
      },
      async (serverUrl) => {
        const result = await searchNotionMcp({ bearer: fixtureToken, serverUrl, query: "owned" })
        expect(result.matches).toHaveLength(results.length)
        expect(result.matches[0]?.snippet).toBeUndefined()
        expect(result.notices).toEqual([])
        expect(result.exhaustive).toBe(false)
      },
    )
  }
})

test("standard search rejects malformed shapes and a URL that disagrees with the physical page", async () => {
  const cases: readonly { payload: unknown; code: string }[] = [
    { payload: { type: "workspace_search", results: {} }, code: "MCP_UNSUPPORTED" },
    { payload: { type: "workspace_search", results: [], notices: {} }, code: "MCP_UNSUPPORTED" },
    ...[
      { ...workspaceHit, type: "connected_content" },
      { ...workspaceHit, title: { text: "UNADMITTED_REMOTE_CONTENT" } },
      { ...workspaceHit, highlight: { text: fixtureToken } },
    ].map((hit) => ({
      payload: { type: "workspace_search", results: [hit] },
      code: "MCP_UNSUPPORTED",
    })),
    ...[
      { ...workspaceHit, id: "invalid" },
      { ...workspaceHit, url: "https://app.notion.com/p/" + workspaceId },
      { ...workspaceHit, url: "https://app.notion.com/unsafe/" + pageId },
      { ...workspaceHit, url: "https://app.notion.com.evil.test/p/" + pageId },
      { ...workspaceHit, url: "http://app.notion.com/p/" + pageId },
    ].map((hit) => ({
      payload: { type: "workspace_search", results: [hit] },
      code: "MCP_INVALID_RESPONSE",
    })),
  ]
  for (const scenario of cases) {
    await fixture(
      (rpc, _request, response) => {
        json(
          response,
          200,
          complete(
            rpc,
            rpc.method === "tools/list" ? toolsResult([searchTool]) : textResult(scenario.payload),
          ),
        )
      },
      async (serverUrl) => {
        await rejected(
          searchNotionMcp({
            bearer: fixtureToken,
            serverUrl,
            query: "owned",
          }),
          scenario.code,
        )
      },
    )
  }
})

test("standard search enforces the caller result limit before admitting any row", async () => {
  await fixture(
    (rpc, _request, response) => {
      json(
        response,
        200,
        complete(
          rpc,
          rpc.method === "tools/list"
            ? toolsResult([searchTool])
            : textResult({ type: "workspace_search", results: [workspaceHit, workspaceHit] }),
        ),
      )
    },
    async (serverUrl) => {
      await rejected(
        searchNotionMcp({
          bearer: fixtureToken,
          serverUrl,
          query: "owned",
          pageSize: 1,
        }),
        "MCP_BUDGET_EXCEEDED",
      )
    },
  )
})

test("source verification invokes only the listed fetch tool and never returns its content", async () => {
  const methods: unknown[] = []
  await fixture(
    (rpc, _request, response) => {
      methods.push(rpc.method)
      if (rpc.method === "tools/list") json(response, 200, complete(rpc, toolsResult([fetchTool])))
      else {
        expect(property(property(rpc.params).arguments)).toEqual({ id: pageId })
        json(
          response,
          200,
          complete(
            rpc,
            textResult({
              metadata: { type: "database" },
              url: "https://app.notion.com/p/" + pageId.replaceAll("-", "") + "?pvs=204",
              title: "UNADMITTED_REMOTE_CONTENT",
              text: fixtureToken,
            }),
          ),
        )
      }
    },
    async (serverUrl) => {
      expect(
        await verifyNotionMcpSource({ bearer: fixtureToken, serverUrl, pageId }),
      ).toBeUndefined()
    },
  )
  expect(methods).toEqual(["tools/list", "tools/call"])
})

test("source verification rejects a different object or non-Notion URL without disclosing content", async () => {
  for (const url of ["https://www.notion.so/" + workspaceId, "https://example.com/" + pageId]) {
    await fixture(
      (rpc, _request, response) => {
        json(
          response,
          200,
          complete(
            rpc,
            rpc.method === "tools/list"
              ? toolsResult([fetchTool])
              : textResult({
                  metadata: { type: "page" },
                  url,
                  title: "UNADMITTED_REMOTE_CONTENT",
                  text: fixtureToken,
                }),
          ),
        )
      },
      async (serverUrl) => {
        await rejected(
          verifyNotionMcpSource({
            bearer: fixtureToken,
            serverUrl,
            pageId,
          }),
          "MCP_UNSUPPORTED",
        )
      },
    )
  }
})

test("identity fallback uses only an advertised fetch tool and its self field", async () => {
  let callName: unknown
  await fixture(
    (rpc, _request, response) => {
      if (rpc.method === "tools/list")
        json(response, 200, complete(rpc, toolsResult([{ ...fetchTool, name: "fetch" }])))
      else {
        callName = property(rpc.params).name
        expect(property(property(rpc.params).arguments)).toEqual({ id: "self" })
        json(response, 200, complete(rpc, textResult({ self: identity })))
      }
    },
    async (serverUrl) => {
      expect(await getNotionMcpIdentity({ bearer: fixtureToken, serverUrl })).toEqual({
        workspaceId,
        principalId,
      })
    },
  )
  expect(callName).toBe("fetch")
})

test("endpoint, argument and budget validation issue no network requests", async () => {
  let calls = 0
  await fixture(
    (_rpc, _request, response) => {
      calls++
      response.end()
    },
    async (serverUrl) => {
      await rejected(
        getNotionMcpIdentity({
          bearer: fixtureToken,
          serverUrl,
          budgets: { maxRequests: 0 },
        }),
        "ARGUMENT_INVALID",
      )
      await rejected(
        getNotionMcpIdentity({
          bearer: fixtureToken,
          serverUrl: serverUrl + "?leak=" + fixtureToken,
        }),
        "CONFIG_ERROR",
      )
      await rejected(
        searchNotionMcp({
          bearer: fixtureToken,
          serverUrl,
          query: " ",
        }),
        "ARGUMENT_INVALID",
      )
      await rejected(
        searchNotionMcp({
          bearer: fixtureToken,
          serverUrl,
          query: "owned fixture",
          pageSize: 0,
        }),
        "ARGUMENT_INVALID",
      )
    },
  )
  expect(calls).toBe(0)
})
