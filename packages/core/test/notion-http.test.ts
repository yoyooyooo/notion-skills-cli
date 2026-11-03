import { expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { Notion } from "../src/notion.ts"
import { NOTION_API_VERSION, NOTION_RESPONSE_LIMIT } from "../src/notion-http.ts"
import { fixtureToken, json, localServer, runtime } from "./notion-http-fixture.ts"

test("real HTTP read and query send explicit version and preserve complete streamed JSON", async () => {
  const observed: Array<{
    url?: string
    method?: string
    token: boolean
    version?: string
    body: string
  }> = []
  await localServer(
    (request, response) => {
      let body = ""
      request.setEncoding("utf8")
      request.on("data", (chunk) => {
        body += chunk
      })
      request.on("end", () => {
        observed.push({
          url: request.url,
          method: request.method,
          body,
          token: request.headers.authorization === `Bearer ${fixtureToken}`,
          version:
            typeof request.headers["notion-version"] === "string"
              ? request.headers["notion-version"]
              : undefined,
        })
        response.writeHead(200, { "content-type": "application/json" })
        response.write('{"object":"list","results":[')
        response.end('{"id":"preserved"}],"has_more":false}')
      })
    },
    async (origin) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const api = yield* Notion
            expect(yield* api.version).toBe(NOTION_API_VERSION)
            const result = yield* api.request(
              "v1/data_sources/sample/query?filter_properties=title",
              { page_size: 100 },
            )
            expect(result).toEqual({
              object: "list",
              results: [{ id: "preserved" }],
              has_more: false,
            })
            expect(api.requestMetrics?.()).toMatchObject({
              total_requests: 1,
              unknown_request_bytes: 0,
              unknown_response_bytes: 0,
              outcomes: { success: 1 },
            })
          }),
        ).pipe(Effect.provide(runtime(origin))),
      )
    },
  )
  expect(observed).toEqual([
    {
      url: "/v1/data_sources/sample/query?filter_properties=title",
      method: "POST",
      token: true,
      version: NOTION_API_VERSION,
      body: '{"page_size":100}',
    },
  ])
})

test("blocked real HTTP errors keep status, request ID and server delay while discarding raw messages", async () => {
  for (const status of [429, 529]) {
    let attempts = 0
    await localServer(
      (_request, response) => {
        attempts++
        json(
          response,
          status,
          {
            object: "error",
            code: status === 429 ? "rate_limited" : "service_overload",
            message: `untrusted body ${fixtureToken}`,
            additional_data: {
              retry_after: "130",
              rate_limit_reason: "public_api_request_blocked",
              unknown: fixtureToken,
            },
            request_id: "req.body",
          },
          { "retry-after": "121", "x-request-id": "req.header" },
        )
      },
      async (origin) => {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const result = yield* (yield* Notion)
                .request("v1/pages", {}, { method: "POST" })
                .pipe(Effect.result)
              expect(result._tag).toBe("Failure")
              if (result._tag !== "Failure") throw new Error("Expected API rejection")
              expect(result.failure.details).toMatchObject({
                http_status: status,
                request_id: "req.header",
                retry_after_seconds: 130,
                retry_after_source: "api",
                retry_after_header_seconds: 121,
                retry_after_body_seconds: 130,
                rate_limit_reason: "public_api_request_blocked",
              })
              expect(result.failure.code).toBe("RATE_LIMITED")
              expect(JSON.stringify(result)).not.toContain(fixtureToken)
              expect(JSON.stringify(result)).not.toContain("untrusted body")
            }),
          ).pipe(Effect.provide(runtime(origin))),
        )
      },
    )
    expect(attempts).toBe(1)
  }
})

test("malicious diagnostic fields cannot echo the current credential", async () => {
  await localServer(
    (_request, response) =>
      json(
        response,
        429,
        {
          object: "error",
          code: "rate_limited",
          request_id: fixtureToken,
          additional_data: { rate_limit_reason: fixtureToken, retry_after: "0" },
        },
        { "x-request-id": fixtureToken },
      ),
    async (origin) => {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.flatMap(Notion, (api) => api.request("v1/pages", {}).pipe(Effect.result)),
        ).pipe(Effect.provide(runtime(origin))),
      )
      expect(JSON.stringify(result)).not.toContain(fixtureToken)
      expect(result._tag === "Failure" && result.failure.code).toBe("RATE_LIMITED")
    },
  )
})

test("saved-write 503 retains only bounded reconciliation identities and known guidance", async () => {
  const id = "11111111-2222-4333-8444-555555555555"
  await localServer(
    (_request, response) =>
      json(response, 503, {
        object: "error",
        code: "service_unavailable",
        message: fixtureToken,
        additional_data: {
          committed_resource_id: id,
          committed_child_ids: [id],
          retry_guidance: [
            "Read the object again to confirm the saved change.",
            "Do not repeat the write.",
            fixtureToken,
          ],
          from: fixtureToken,
          elapsed_ms: fixtureToken,
        },
      }),
    async (origin) => {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.flatMap(Notion, (api) => api.request("v1/pages", {}).pipe(Effect.result)),
        ).pipe(Effect.provide(runtime(origin))),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag !== "Failure") throw new Error("Expected unknown write")
      expect(result.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
      expect(result.failure.details).toMatchObject({
        additional_data: {
          committed_resource_id: id,
          committed_child_ids: [id],
          retry_guidance: [
            "Read the object again to confirm the saved change.",
            "Do not repeat the write.",
          ],
        },
      })
      expect(JSON.stringify(result)).not.toContain(fixtureToken)
    },
  )
})

test("a malformed rate-limited response preserves headers, closes the body and enforces shared cooldown", async () => {
  let attempts = 0
  await localServer(
    (_request, response) => {
      attempts++
      response.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "121",
        "x-request-id": "invalid-body-request",
      })
      response.end('{"truncated":')
    },
    async (origin) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const api = yield* Notion
            const failed = yield* api
              .request("v1/pages", {}, { method: "POST" })
              .pipe(Effect.result)
            expect(failed._tag).toBe("Failure")
            if (failed._tag !== "Failure") throw new Error("Partial response was accepted")
            expect(failed.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
            expect(failed.failure.details).toMatchObject({
              http_status: 429,
              request_id: "invalid-body-request",
              retry_after_seconds: 121,
              reason: "invalid_json",
            })
            const queued = yield* api
              .request("v1/pages/after", undefined, { queueBudgetMs: 1 })
              .pipe(Effect.result)
            expect(queued._tag === "Failure" && queued.failure.code).toBe("RATE_LIMITED")
            expect(api.requestMetrics?.()).toMatchObject({
              total_requests: 1,
              unknown_response_bytes: 0,
            })
          }),
        ).pipe(Effect.provide(runtime(origin))),
      )
    },
  )
  expect(attempts).toBe(1)
})

test("invalid JSON and oversized successful bodies fail closed through the real response stream", async () => {
  for (const large of [false, true]) {
    await localServer(
      (_request, response) => {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(large ? "x".repeat(NOTION_RESPONSE_LIMIT + 1) : '{"incomplete":')
      },
      async (origin) => {
        const result = await Effect.runPromise(
          Effect.scoped(
            Effect.flatMap(Notion, (api) => api.request("v1/pages/example").pipe(Effect.result)),
          ).pipe(Effect.provide(runtime(origin))),
        )
        expect(result._tag).toBe("Failure")
        if (result._tag !== "Failure") throw new Error("Expected invalid response")
        expect(result.failure.code).toBe("INVALID_RESPONSE")
        expect(result.failure.details).toMatchObject({
          reason: large ? "response_limit" : "invalid_json",
        })
      },
    )
  }
})

test("cancellation after response headers closes the real HTTP stream and does not retry", async () => {
  let attempts = 0
  let started!: () => void
  let closed!: () => void
  const start = new Promise<void>((resolve) => {
    started = resolve
  })
  const close = new Promise<void>((resolve) => {
    closed = resolve
  })
  await localServer(
    (_request, response) => {
      attempts++
      response.writeHead(200, { "content-type": "application/json" })
      response.write('{"pending":')
      response.on("close", closed)
      started()
    },
    async (origin) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const api = yield* Notion
            const running = yield* Effect.forkChild(api.request("v1/pages/stream"), {
              startImmediately: true,
            })
            yield* Effect.promise(() => start)
            yield* Fiber.interrupt(running)
            yield* Effect.promise(() => close).pipe(Effect.timeout(2_000))
            expect(api.requestMetrics?.()).toMatchObject({
              total_requests: 1,
              in_flight: 0,
              outcomes: { cancelled: 1 },
            })
          }),
        ).pipe(Effect.provide(runtime(origin))),
      )
    },
  )
  expect(attempts).toBe(1)
})

test("a timed-out real write is unknown, aborted and never sent twice", async () => {
  let attempts = 0
  await localServer(
    (request, _response) => {
      attempts++
      request.resume()
    },
    async (origin) => {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.flatMap(Notion, (api) => api.request("v1/pages", {}).pipe(Effect.result)),
        ).pipe(
          Effect.provide(runtime(origin, { config: { NTN_SKILLS_REQUEST_TIMEOUT_MS: "100" } })),
        ),
      )
      expect(result._tag === "Failure" && result.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
      expect(JSON.stringify(result)).toContain('"reason":"timeout"')
    },
  )
  expect(attempts).toBe(1)
})

test("redirects never follow a credential-bearing request", async () => {
  let destinationRequests = 0
  await localServer(
    (request, response) => {
      if (request.url === "/v1/redirect") {
        response.writeHead(302, { location: "/v1/forbidden" })
        response.end("{}")
      } else {
        destinationRequests++
        json(response, 200, {})
      }
    },
    async (origin) => {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.flatMap(Notion, (api) => api.request("v1/redirect").pipe(Effect.result)),
        ).pipe(Effect.provide(runtime(origin))),
      )
      expect(result._tag).toBe("Failure")
    },
  )
  expect(destinationRequests).toBe(0)
})

test("one operation pins its credential while a fresh service observes rotation, revocation and removal", async () => {
  let token: string | undefined = "credential_a"
  const requests: string[] = []
  await localServer(
    (request, response) => {
      const authorization = request.headers.authorization ?? ""
      requests.push(
        authorization === "Bearer credential_a"
          ? "a"
          : authorization === "Bearer credential_b"
            ? "b"
            : "revoked",
      )
      if (authorization === "Bearer revoked")
        return json(response, 401, { object: "error", code: "unauthorized", message: token })
      json(response, 200, {
        object: "user",
        id:
          authorization === "Bearer credential_a"
            ? "11111111-1111-4111-8111-111111111111"
            : "22222222-2222-4222-8222-222222222222",
        bot: { workspace_id: "33333333-3333-4333-8333-333333333333" },
      })
    },
    async (origin) => {
      const options = {
        token: () => token,
        config: { NOTION_WORKSPACE_ID: "forged_workspace", NTN_SKILLS_NTN_BIN: "/must-not-run" },
      }
      const first = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const api = yield* Notion
            if (!api.connectionIdentity) throw new Error("Expected verified identity")
            const first = yield* api.connectionIdentity
            token = "credential_b"
            const stillPinned = yield* api.connectionIdentity
            expect(stillPinned).toEqual(first)
            return first
          }),
        ).pipe(Effect.provide(runtime(origin, options))),
      )
      const second = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const api = yield* Notion
            if (!api.connectionIdentity) throw new Error("Expected verified identity")
            return yield* api.connectionIdentity
          }),
        ).pipe(Effect.provide(runtime(origin, options))),
      )
      expect(second.credential).not.toBe(first.credential)
      expect(second.connection).not.toBe(first.connection)
      expect(second.workspace).toBe("33333333-3333-4333-8333-333333333333")
      token = "revoked"
      const revoked = await Effect.runPromise(
        Effect.scoped(
          Effect.flatMap(Notion, (api) => api.request("v1/users/me").pipe(Effect.result)),
        ).pipe(Effect.provide(runtime(origin, options))),
      )
      expect(revoked._tag === "Failure" && revoked.failure.code).toBe("AUTH_REQUIRED")
      token = undefined
      const missing = await Effect.runPromise(
        Effect.scoped(
          Effect.flatMap(Notion, (api) => api.request("v1/users/me").pipe(Effect.result)),
        ).pipe(Effect.provide(runtime(origin, options))),
      )
      expect(missing._tag === "Failure" && missing.failure.code).toBe("AUTH_REQUIRED")
    },
  )
  expect(requests).toEqual(["a", "a", "b", "revoked"])
})

test("workspace identity remains unknown without service evidence", async () => {
  await localServer(
    (_request, response) =>
      json(response, 200, {
        object: "user",
        id: "11111111-1111-4111-8111-111111111111",
        bot: { workspace_name: "Not an identifier" },
      }),
    async (origin) => {
      const identity = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const api = yield* Notion
            if (!api.connectionIdentity) throw new Error("Expected identity")
            return yield* api.connectionIdentity
          }),
        ).pipe(
          Effect.provide(
            runtime(origin, {
              config: { NOTION_WORKSPACE_ID: "33333333-3333-4333-8333-333333333333" },
            }),
          ),
        ),
      )
      expect(identity.workspace).toBeNull()
    },
  )
})

test("non-JSON inputs and foreign paths are rejected before an HTTP attempt", async () => {
  let attempts = 0
  await localServer(
    (_request, response) => {
      attempts++
      json(response, 200, {})
    },
    async (origin) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const api = yield* Notion
            const invalidBody = yield* api.request("v1/pages", { invalid: 1n }).pipe(Effect.result)
            expect(invalidBody._tag === "Failure" && invalidBody.failure.code).toBe(
              "ARGUMENT_INVALID",
            )
            const invalidPath = yield* api
              .request("https://outside.invalid/v1/pages")
              .pipe(Effect.result)
            expect(invalidPath._tag === "Failure" && invalidPath.failure.code).toBe(
              "ARGUMENT_INVALID",
            )
            expect(api.requestMetrics?.()).toMatchObject({ total_requests: 0 })
          }),
        ).pipe(Effect.provide(runtime(origin))),
      )
    },
  )
  expect(attempts).toBe(0)
})
