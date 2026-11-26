import { expect, test } from "@effect/vitest"
import { Effect } from "effect"
import { spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { createServer, type ServerResponse } from "node:http"
import { mkdtemp, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  getMcpAuthStatus,
  loginMcp,
  logoutMcp,
  resolveMcpCredential,
  setMcpToken,
  type McpAuthOptions,
  type McpAuthorizationRequest,
} from "../src/notion-mcp-auth.ts"
import { McpCredentialStore } from "../src/notion-mcp-credential-store.ts"
import { trashPath } from "../src/local-locks.ts"
import { fail } from "../src/model.ts"

const fixtureIdentity = { workspaceId: "fixture-workspace", principalId: "fixture-person" }
function latch<A>() {
  let resolve: (value: A) => void = () => undefined
  const promise = new Promise<A>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
async function text(request: AsyncIterable<Uint8Array>) {
  const chunks: Uint8Array[] = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks).toString("utf8")
}
type RefreshMode =
  | "success"
  | "invalid_grant"
  | "hold"
  | "missing_refresh"
  | "changed_identity"
  | "denied"
  | "denied_html"
  | "limited"
  | "invalid_scope"
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ntn-mcp-auth-"))
  let origin = ""
  let tokenNumber = 0
  let expectedRefresh = ""
  let registrationCount = 0
  let exchangeCount = 0
  let refreshCount = 0
  let identityCount = 0
  let codeNumber = 0
  let callbackUri = ""
  let refreshMode: RefreshMode = "success"
  const refreshReceived = latch<void>()
  const refreshRelease = latch<void>()
  const pendingMarkers: string[] = []
  const codes = new Map<
    string,
    {
      challenge: string
      redirect: string
      resource: string
      clientId: string
    }
  >()
  const json = (response: ServerResponse, value: unknown, status = 200) => {
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value))
  }
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", origin)
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        json(response, {
          resource: origin + "/mcp",
          authorization_servers: [origin],
          scopes_supported: ["default"],
        })
        return
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        json(response, {
          issuer: origin,
          authorization_endpoint: origin + "/authorize",
          token_endpoint: origin + "/token",
          registration_endpoint: origin + "/register",
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          authorization_response_iss_parameter_supported: true,
        })
        return
      }
      if (url.pathname === "/register") {
        const body: unknown = JSON.parse(await text(request))
        if (
          body === null ||
          typeof body !== "object" ||
          !("redirect_uris" in body) ||
          !Array.isArray(body.redirect_uris) ||
          typeof body.redirect_uris[0] !== "string"
        )
          throw new Error("Invalid fixture registration.")
        callbackUri = body.redirect_uris[0]
        registrationCount++
        json(response, {
          client_id: "fixture-client",
          token_endpoint_auth_method: "none",
          redirect_uris: [callbackUri],
        })
        return
      }
      if (url.pathname === "/authorize") {
        if (
          url.searchParams.get("resource") !== origin + "/mcp" ||
          url.searchParams.get("code_challenge_method") !== "S256" ||
          url.searchParams.get("redirect_uri") !== callbackUri ||
          url.searchParams.get("client_id") !== "fixture-client" ||
          url.searchParams.get("scope") !== "default"
        )
          throw new Error("Invalid fixture authorization.")
        const code = "fixture-code-" + ++codeNumber
        codes.set(code, {
          challenge: url.searchParams.get("code_challenge") ?? "",
          redirect: callbackUri,
          resource: origin + "/mcp",
          clientId: "fixture-client",
        })
        const location = new URL(callbackUri)
        location.searchParams.set("state", url.searchParams.get("state") ?? "")
        location.searchParams.set("iss", origin)
        location.searchParams.set("code", code)
        response.writeHead(302, { location: location.href }).end()
        return
      }
      if (url.pathname === "/token") {
        const form = new URLSearchParams(await text(request))
        if (form.get("client_id") !== "fixture-client" || form.get("resource") !== origin + "/mcp")
          throw new Error("Invalid fixture token resource or client.")
        if (form.get("grant_type") === "authorization_code") {
          exchangeCount++
          const authorization = codes.get(form.get("code") ?? "")
          if (
            !authorization ||
            createHash("sha256")
              .update(form.get("code_verifier") ?? "")
              .digest("base64url") !== authorization.challenge ||
            form.get("redirect_uri") !== authorization.redirect
          ) {
            json(response, { error: "invalid_grant" }, 400)
            return
          }
          codes.delete(form.get("code") ?? "")
        } else if (form.get("grant_type") === "refresh_token") {
          refreshCount++
          const stored = await readFile(store().file, "utf8")
          pendingMarkers.push(stored)
          refreshReceived.resolve()
          if (form.get("refresh_token") !== expectedRefresh || refreshMode === "invalid_grant") {
            json(response, { error: "invalid_grant" }, 400)
            return
          }
          if (refreshMode === "invalid_scope") {
            json(response, { error: "invalid_scope" }, 400)
            return
          }
          if (refreshMode === "denied") {
            json(response, { error: "access_denied" }, 403)
            return
          }
          if (refreshMode === "denied_html") {
            response
              .writeHead(403, { "content-type": "text/html" })
              .end("fixture intermediary denied request")
            return
          }
          if (refreshMode === "limited") {
            json(response, { error: "rate_limited" }, 429)
            return
          }
          // Rotate on receipt. A killed client must never replay this old token.
          expectedRefresh = "consumed"
          if (refreshMode === "hold") await refreshRelease.promise
        } else throw new Error("Unexpected fixture grant type.")
        tokenNumber++
        expectedRefresh = "fixture-refresh-" + tokenNumber
        json(response, {
          token_type: "Bearer",
          access_token: "fixture-access-" + tokenNumber,
          ...(refreshMode === "missing_refresh" && form.get("grant_type") === "refresh_token"
            ? {}
            : { refresh_token: expectedRefresh }),
          expires_in: 3600,
          scope: "default",
          resource: origin + "/mcp",
          ...(form.get("grant_type") === "authorization_code"
            ? {
                workspace_id: fixtureIdentity.workspaceId,
                user_id: fixtureIdentity.principalId,
              }
            : refreshMode === "changed_identity"
              ? {
                  workspace_id: "foreign-workspace",
                  user_id: fixtureIdentity.principalId,
                }
              : {}),
        })
        return
      }
      if (url.pathname === "/self") {
        identityCount++
        const authorization = request.headers.authorization
        if (
          authorization !== "Bearer fixture-access-" + tokenNumber &&
          authorization !== "Bearer explicit-good" &&
          authorization !== "Bearer environment-good"
        ) {
          json(response, { error: "unauthorized" }, 401)
          return
        }
        json(response, fixtureIdentity)
        return
      }
      response.writeHead(404).end()
    })().catch(() => json(response, { error: "fixture_failed" }, 500))
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Fixture failed to bind.")
  origin = "http://127.0.0.1:" + address.port
  const resolveIdentity: NonNullable<McpAuthOptions["resolveIdentity"]> = async (request) => {
    const response = await fetch(origin + "/self", {
      headers: { authorization: "Bearer " + request.bearer },
      signal: request.signal,
    })
    if (!response.ok) throw fail("MCP_AUTH_REQUIRED", "The explicit fixture bearer was rejected.")
    return fixtureIdentity
  }
  const options: McpAuthOptions = {
    env: {},
    configHome: join(root, "config"),
    serverUrl: origin + "/mcp",
    resolveIdentity,
  }
  const store = () =>
    new McpCredentialStore({
      configHome: join(root, "config"),
      profile: "default",
      serverUrl: origin + "/mcp",
      deadline: Date.now() + 10_000,
    })
  const authorize = async ({ url }: McpAuthorizationRequest, mutate?: (callback: URL) => void) => {
    const response = await fetch(url, { redirect: "manual" })
    const location = response.headers.get("location")
    if (!location) throw new Error("Fixture authorization did not redirect.")
    const callback = new URL(location)
    mutate?.(callback)
    await fetch(callback)
  }
  return {
    options,
    store,
    authorize,
    root,
    origin,
    get registrations() {
      return registrationCount
    },
    get exchanges() {
      return exchangeCount
    },
    get refreshes() {
      return refreshCount
    },
    get identities() {
      return identityCount
    },
    get pendingMarkers() {
      return pendingMarkers
    },
    setRefreshMode(mode: RefreshMode) {
      refreshMode = mode
    },
    refreshReceived: refreshReceived.promise,
    releaseRefresh() {
      refreshRelease.resolve()
    },
    async expire() {
      await store().transaction(async (state, commit) => {
        if (state.oauth.kind !== "ready") throw new Error("Fixture needs a grant.")
        await commit({ ...state, oauth: { ...state.oauth, expiresAt: 0 } })
      })
    },
    async close() {
      refreshRelease.resolve()
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
      if (process.platform === "darwin") await Effect.runPromise(trashPath(root))
    },
  }
}
async function withFixture(run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture()
  try {
    await run(f)
  } finally {
    await f.close()
  }
}
function presentUntilClosed(captured: ReturnType<typeof latch<string>>) {
  return async (request: McpAuthorizationRequest) => {
    captured.resolve(request.url)
    await new Promise<void>((done) => {
      request.signal.addEventListener("abort", () => done(), { once: true })
      if (request.signal.aborted) done()
    })
  }
}

test("OAuth uses the real loopback callback, PKCE, resource and verified identity; DCR is reused", async () => {
  await withFixture(async (f) => {
    const first = await loginMcp({ ...f.options, onAuthorize: f.authorize })
    expect(first.oauth).toBe("ready")
    expect(first.identity).toEqual(fixtureIdentity)
    expect(f.registrations).toBe(1)
    expect(f.exchanges).toBe(1)
    const credential = await resolveMcpCredential(f.options)
    expect(credential.kind).toBe("oauth")
    expect(credential.workspaceId).toBe(fixtureIdentity.workspaceId)
    expect((await stat(f.store().file)).mode & 0o777).toBe(0o600)
    expect((await stat(f.store().directory)).mode & 0o777).toBe(0o700)
    expect(JSON.stringify(first)).not.toMatch(/fixture-(access|refresh)-/)
    await logoutMcp(f.options)
    await expect(credential.assertCurrent()).rejects.toMatchObject({ code: "MCP_AUTH_STALE" })
    const second = await loginMcp({ ...f.options, onAuthorize: f.authorize })
    expect(second.oauth).toBe("ready")
    expect(second.grantEpoch).not.toBe(first.grantEpoch)
    expect(second.connectionId).toBe(first.connectionId)
    expect(f.registrations).toBe(1)
    expect(f.exchanges).toBe(2)
  })
})

test("environment and stored explicit tokens override OAuth, invalid tokens never switch principal", async () => {
  await withFixture(async (f) => {
    await loginMcp({ ...f.options, onAuthorize: f.authorize })
    const before = await f.store().read()
    await setMcpToken("explicit-bad", f.options)
    let presented = 0
    await expect(
      loginMcp({
        ...f.options,
        onAuthorize: async () => {
          presented++
        },
      }),
    ).rejects.toMatchObject({ code: "MCP_AUTH_TOKEN_ACTIVE" })
    await expect(
      resolveMcpCredential({
        ...f.options,
        interactive: true,
        onAuthorize: async () => {
          presented++
        },
      }),
    ).rejects.toMatchObject({ code: "MCP_AUTH_INVALID_TOKEN" })
    expect(presented).toBe(0)
    expect(f.exchanges).toBe(1)
    expect((await f.store().read()).oauth).toEqual(before.oauth)
    await setMcpToken("explicit-good", f.options)
    expect((await resolveMcpCredential(f.options)).kind).toBe("token")
    const saved = await getMcpAuthStatus(f.options)
    expect(saved.tokenSource).toBe("stored")
    expect(saved.identity).toBeNull()
    const environmentOptions = { ...f.options, env: { NOTION_MCP_TOKEN: "environment-good" } }
    const overridden = await resolveMcpCredential(environmentOptions)
    expect(overridden.bearer).toBe("environment-good")
    const a = await getMcpAuthStatus(environmentOptions)
    const b = await getMcpAuthStatus({
      ...f.options,
      env: { NOTION_MCP_TOKEN: "environment-other" },
    })
    expect(a.connectionId).toBe(b.connectionId)
    expect(a.grantEpoch).not.toBe(b.grantEpoch)
    expect(b.identity).toBeNull()
    const cleared = await setMcpToken(undefined, f.options)
    expect(cleared.oauth).toBe("ready")
    expect((await resolveMcpCredential(f.options)).kind).toBe("oauth")
    const loggedOut = await logoutMcp(environmentOptions)
    expect(loggedOut.oauth).toBe("absent")
    expect(loggedOut.tokenSource).toBe("environment")
    expect(loggedOut.identity).toBeNull()
  })
})

test("headless auth and missing identity capability return before network or browser", async () => {
  await withFixture(async (f) => {
    await expect(resolveMcpCredential(f.options)).rejects.toMatchObject({
      code: "MCP_AUTH_REQUIRED",
      details: { next: { argv: ["ntn-skills", "auth", "mcp", "login"], read_only: false } },
    })
    await expect(loginMcp(f.options)).rejects.toMatchObject({ code: "MCP_AUTH_REQUIRED" })
    await setMcpToken("explicit-good", f.options)
    await expect(
      resolveMcpCredential({ ...f.options, resolveIdentity: undefined }),
    ).rejects.toMatchObject({ code: "MCP_AUTH_IDENTITY_REQUIRED" })
    expect(f.exchanges + f.registrations + f.identities).toBe(0)
  })
})

for (const name of ["state", "issuer", "duplicate", "resource", "redirect", "code-and-error"]) {
  test("callback rejects " + name + " before exchanging an authorization code", async () => {
    await withFixture(async (f) => {
      const result = await loginMcp({
        ...f.options,
        onAuthorize: (request) =>
          f.authorize(request, (url) => {
            if (name === "state") url.searchParams.set("state", "wrong-state")
            if (name === "issuer") url.searchParams.set("iss", "https://foreign.invalid")
            if (name === "duplicate")
              url.searchParams.append("state", url.searchParams.get("state") ?? "")
            if (name === "resource") url.searchParams.set("resource", "https://foreign.invalid/mcp")
            if (name === "redirect")
              url.searchParams.set("redirect_uri", "http://127.0.0.1:1/callback")
            if (name === "code-and-error") url.searchParams.set("error", "access_denied")
          }),
      }).then(
        (value) => value,
        (error: unknown) => error,
      )
      expect(result).toMatchObject({ code: "MCP_AUTH_CALLBACK_INVALID" })
      expect(f.exchanges).toBe(0)
      expect((await getMcpAuthStatus(f.options)).oauth).toBe("absent")
    })
  })
}

test("one cancelled waiter leaves the shared authorization and another UI alive", async () => {
  await withFixture(async (f) => {
    const a = latch<string>(),
      b = latch<string>()
    const controller = new AbortController()
    const first = loginMcp({
      ...f.options,
      signal: controller.signal,
      onAuthorize: presentUntilClosed(a),
    })
    const firstResult = first.then(
      () => "success",
      (error: unknown) => error,
    )
    const second = loginMcp({ ...f.options, onAuthorize: presentUntilClosed(b) }).then(
      (value) => value,
      (error: unknown) => error,
    )
    const [urlA, urlB] = await Promise.all([a.promise, b.promise])
    expect(urlA).toBe(urlB)
    controller.abort()
    expect(await firstResult).toMatchObject({ code: "MCP_AUTH_CANCELLED" })
    await f
      .authorize({ url: urlB, signal: new AbortController().signal, deadline: Date.now() + 5000 })
      .catch(() => undefined)
    expect(await second).toMatchObject({ oauth: "ready" })
    expect(f.exchanges).toBe(1)
  })
})

test("one rejected presentation detaches only its waiter", async () => {
  await withFixture(async (f) => {
    const visible = latch<string>()
    const first = loginMcp({
      ...f.options,
      onAuthorize: async () => {
        throw fail("MCP_AUTH_CANCELLED", "Closed fixture UI.")
      },
    }).then(
      () => "success",
      (error: unknown) => error,
    )
    const second = loginMcp({ ...f.options, onAuthorize: presentUntilClosed(visible) })
    const url = await visible.promise
    expect(await first).toMatchObject({ code: "MCP_AUTH_CANCELLED" })
    await f.authorize({ url, signal: new AbortController().signal, deadline: Date.now() + 5000 })
    expect((await second).oauth).toBe("ready")
  })
})

test("last waiter cancellation retires the listener and no late callback can exchange", async () => {
  await withFixture(async (f) => {
    const visible = latch<string>(),
      controller = new AbortController()
    const pending = loginMcp({
      ...f.options,
      signal: controller.signal,
      onAuthorize: presentUntilClosed(visible),
    }).then(
      () => "success",
      (error: unknown) => error,
    )
    const url = await visible.promise
    controller.abort()
    expect(await pending).toMatchObject({ code: "MCP_AUTH_CANCELLED" })
    await f
      .authorize({ url, signal: new AbortController().signal, deadline: Date.now() + 5000 })
      .catch(() => undefined)
    await new Promise((done) => setTimeout(done, 30))
    expect(f.exchanges).toBe(0)
    expect((await getMcpAuthStatus(f.options)).oauth).toBe("absent")
  })
})

test("logout in another process during identity verification prevents the late grant commit", async () => {
  await withFixture(async (f) => {
    const entered = latch<void>(),
      release = latch<void>()
    const pending = loginMcp({
      ...f.options,
      onAuthorize: f.authorize,
      resolveIdentity: async () => {
        entered.resolve()
        await release.promise
        return fixtureIdentity
      },
    }).then(
      () => "success",
      (error: unknown) => error,
    )
    await entered.promise
    const logout = authChild(f.options, "logoutMcp")
    try {
      expect((await logout.done).code).toBe(0)
    } finally {
      await stopChild(logout.child)
    }
    release.resolve()
    expect(await pending).toMatchObject({ code: "MCP_AUTH_STALE" })
    expect(f.exchanges).toBe(1)
    expect((await getMcpAuthStatus(f.options)).oauth).toBe("absent")
  })
})

test("authorization deadlines retire presentation and do not publish a late zero-waiter grant", async () => {
  await withFixture(async (f) => {
    const visible = latch<McpAuthorizationRequest>()
    const currentTime = Date.now
    const currentTimer = globalThis.setTimeout
    const owner = new AbortController()
    let now = currentTime()
    let expireWaiter: (() => void) | undefined
    let pending: Promise<unknown> | undefined
    function observedTimer<Args extends unknown[]>(
      callback: (...args: Args) => void,
      delay?: number,
      ...args: Args
    ): ReturnType<typeof setTimeout> {
      const timer = currentTimer(callback, delay, ...args)
      if (delay === 500 && expireWaiter === undefined) {
        clearTimeout(timer)
        expireWaiter = () => callback(...args)
      }
      return timer
    }
    // Setup includes real fsync, discovery and registration. Hold only this
    // caller's deadline until its actual presentation has been observed.
    Date.now = () => now
    globalThis.setTimeout = Object.assign(observedTimer, currentTimer)
    try {
      pending = loginMcp({
        ...f.options,
        signal: owner.signal,
        deadline: now + 500,
        onAuthorize: (request) => {
          visible.resolve(request)
          return new Promise<void>((resolve) => {
            request.signal.addEventListener("abort", () => resolve(), { once: true })
            if (request.signal.aborted) resolve()
          })
        },
      }).then(
        (value) => value,
        (error: unknown) => error,
      )
      const request = await Promise.race([
        visible.promise,
        pending.then((outcome) => {
          throw new Error("Authorization ended before its presentation was observed.", {
            cause: outcome,
          })
        }),
      ])
      expect(expireWaiter).toBeDefined()
      if (!expireWaiter) throw new Error("The fixture did not observe the caller deadline timer.")
      now = request.deadline + 1
      expireWaiter()
      expect(await pending).toMatchObject({ code: "MCP_AUTH_TIMEOUT" })
      expect(request.signal.aborted).toBe(true)
      await f.authorize(request).catch(() => undefined)
      expect(f.exchanges).toBe(0)
      const status = await getMcpAuthStatus(f.options)
      expect(status.oauth).toBe("absent")
      expect(status.identity).toBeNull()
    } finally {
      owner.abort()
      Date.now = currentTime
      globalThis.setTimeout = currentTimer
      await pending
    }
  })
})

test("refresh saves a durable marker before dispatch, rotates atomically and preserves identity and epoch", async () => {
  await withFixture(async (f) => {
    const loggedIn = await loginMcp({ ...f.options, onAuthorize: f.authorize })
    await f.expire()
    f.setRefreshMode("hold")
    const pending = Promise.allSettled([resolveMcpCredential(f.options)])
    await f.refreshReceived
    expect(f.pendingMarkers[0]).toContain('"kind":"pending"')
    f.releaseRefresh()
    const [completed] = await pending
    expect(completed?.status).toBe("fulfilled")
    if (completed?.status !== "fulfilled") return
    const result = completed.value
    const saved = await f.store().read()
    expect(result.kind).toBe("oauth")
    expect(result.grantEpoch).toBe(loggedIn.grantEpoch)
    expect(result.connectionId).toBe(loggedIn.connectionId)
    expect(result.workspaceId).toBe(fixtureIdentity.workspaceId)
    expect(result.revision).toBe(loggedIn.revision + 1)
    expect(f.refreshes).toBe(1)
    expect(saved.oauth).toMatchObject({
      kind: "ready",
      refresh: { kind: "idle" },
      identity: fixtureIdentity,
    })
    expect(f.identities).toBe(1)
  })
})

for (const mode of [
  "invalid_grant",
  "missing_refresh",
  "changed_identity",
] satisfies RefreshMode[]) {
  test("refresh " + mode + " ends in reauthorization without replay", async () => {
    await withFixture(async (f) => {
      await loginMcp({ ...f.options, onAuthorize: f.authorize })
      await f.expire()
      f.setRefreshMode(mode)
      await expect(resolveMcpCredential(f.options)).rejects.toMatchObject({
        code: "MCP_AUTH_REAUTH_REQUIRED",
      })
      await expect(resolveMcpCredential(f.options)).rejects.toMatchObject({
        code: "MCP_AUTH_REAUTH_REQUIRED",
      })
      expect(f.refreshes).toBe(1)
      expect((await getMcpAuthStatus(f.options)).oauth).toBe("reauth_required")
    })
  })
}

test("a timed-out refresh leaves its marker; a still-live successor does not replay the consumed token", async () => {
  await withFixture(async (f) => {
    await loginMcp({ ...f.options, onAuthorize: f.authorize })
    await f.expire()
    f.setRefreshMode("hold")
    const first = resolveMcpCredential({ ...f.options, deadline: Date.now() + 500 }).then(
      () => "success",
      (error: unknown) => error,
    )
    await f.refreshReceived
    const second = resolveMcpCredential({ ...f.options, deadline: Date.now() + 5000 }).then(
      () => "success",
      (error: unknown) => error,
    )
    expect(await first).toMatchObject({ code: "MCP_AUTH_TIMEOUT" })
    expect(await second).toMatchObject({ code: "MCP_AUTH_REAUTH_REQUIRED" })
    expect(f.refreshes).toBe(1)
    f.releaseRefresh()
  })
})

for (const mode of ["denied", "denied_html", "limited"] satisfies RefreshMode[]) {
  test(
    "refresh " +
      mode +
      " preserves classification and requires explicit recovery without automatic OAuth",
    async () => {
      await withFixture(async (f) => {
        await loginMcp({ ...f.options, onAuthorize: f.authorize })
        await f.expire()
        f.setRefreshMode(mode)
        await expect(resolveMcpCredential(f.options)).rejects.toMatchObject({
          code: mode === "limited" ? "MCP_RATE_LIMITED" : "MCP_ACCESS_DENIED",
        })
        expect((await f.store().read()).oauth).toMatchObject({
          kind: "ready",
          refresh: { kind: "pending" },
        })
        let shown = 0
        await expect(
          resolveMcpCredential({
            ...f.options,
            interactive: true,
            onAuthorize: async () => {
              shown++
            },
          }),
        ).rejects.toMatchObject({ code: "MCP_AUTH_REAUTH_REQUIRED" })
        expect(shown).toBe(0)
        expect(f.refreshes).toBe(1)
      })
    },
  )
}

test("a parsed OAuth invalid_scope response clears only its rejected marker, with no implicit retry", async () => {
  await withFixture(async (f) => {
    await loginMcp({ ...f.options, onAuthorize: f.authorize })
    await f.expire()
    const before = await f.store().read()
    f.setRefreshMode("invalid_scope")
    await expect(resolveMcpCredential(f.options)).rejects.toMatchObject({
      code: "MCP_INSUFFICIENT_SCOPE",
    })
    expect(await f.store().read()).toEqual(before)
    expect(f.refreshes).toBe(1)
    f.setRefreshMode("success")
    expect((await resolveMcpCredential(f.options)).kind).toBe("oauth")
    expect(f.refreshes).toBe(2)
  })
})

const authUrl = new URL("../src/notion-mcp-auth.ts", import.meta.url).href
const storeUrl = new URL("../src/notion-mcp-credential-store.ts", import.meta.url).href
function authChild(
  options: McpAuthOptions,
  operation: "resolveMcpCredential" | "logoutMcp" = "resolveMcpCredential",
  holdFenceRead = false,
) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {${operation} as operation} from ${JSON.stringify(authUrl)};
    import {McpCredentialStore} from ${JSON.stringify(storeUrl)};
    import fs from "node:fs";
    import {syncBuiltinESMExports} from "node:module";
    const holdFenceRead=${JSON.stringify(holdFenceRead)};
    const fenceSuffix="/sync/locks/"+${JSON.stringify(createHash("sha256").update("notion-mcp-credentials").digest("hex"))};
    const lstat=fs.lstat;
    let heldFence,ownedRead=false;
    if(holdFenceRead) {
      fs.lstat=function(location,...args) {
        if(heldFence===undefined && String(location).endsWith(fenceSuffix)) {
          heldFence=String(location);
          process.send?.("fence-observed");
          process.once("message",()=>lstat.call(fs,location,...args));
          return;
        }
        return lstat.call(fs,location,...args);
      };
      syncBuiltinESMExports();
    }
    const read=McpCredentialStore.prototype.read;
    let observed=false;
    McpCredentialStore.prototype.read=async function() {
      const state=await read.call(this);
      if(heldFence!==undefined && fs.existsSync(heldFence+"/owner.json")) {
        ownedRead=JSON.parse(fs.readFileSync(heldFence+"/owner.json","utf8")).pid===process.pid;
      }
      if(!observed && state.oauth.kind==="ready" && state.oauth.refresh.kind==="pending") {
        observed=true;
        process.send?.("read-pending");
      }
      return state;
    };
    try {
      const result=await operation(${JSON.stringify({
        env: {},
        configHome: options.configHome,
        serverUrl: options.serverUrl,
        deadline: Date.now() + 15_000,
      })});
      process.stdout.write(JSON.stringify({kind:result.kind,revision:result.revision})+"\\n");
    } catch(error) {
      process.stdout.write(JSON.stringify({code:error.code,...(holdFenceRead?{ownedRead,details:error.details}:{})})+"\\n");
      process.exitCode=1;
    } finally {
      process.disconnect?.();
    }
  `,
    ],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  )
  const observedPending = latch<void>()
  const observedFence = latch<void>()
  child.on("message", (message: unknown) => {
    if (message === "read-pending") observedPending.resolve()
    if (message === "fence-observed") observedFence.resolve()
  })
  let output = "",
    errors = ""
  if (child.stdout === null || child.stderr === null) {
    child.kill("SIGKILL")
    throw new Error("The fixture child must capture stdout and stderr.")
  }
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8")
  })
  child.stderr.on("data", (chunk: Buffer) => {
    errors += chunk.toString("utf8")
  })
  const done = once(child, "exit").then(([code, signal]) => ({ code, signal, output, errors }))
  return {
    child,
    done,
    observedPending: observedPending.promise,
    observedFence: observedFence.promise,
  }
}
async function stopChild(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL")
    await once(child, "exit")
  }
}
async function childReachedRefresh(received: Promise<void>, child: ReturnType<typeof authChild>) {
  await Promise.race([
    received,
    child.done.then((result) => {
      throw new Error("Child exited before refresh: " + result.output + result.errors)
    }),
  ])
}

test("a successor retries a normally released fence and rereads its marker only after reacquiring ownership", async () => {
  await withFixture(async (f) => {
    await loginMcp({ ...f.options, onAuthorize: f.authorize })
    await f.expire()
    f.setRefreshMode("hold")
    const controller = new AbortController()
    const first = resolveMcpCredential({
      ...f.options,
      signal: controller.signal,
      deadline: Date.now() + 15_000,
    }).then(
      () => "success",
      (error: unknown) => error,
    )
    let successor: ReturnType<typeof authChild> | undefined
    try {
      await f.refreshReceived
      successor = authChild(f.options, "resolveMcpCredential", true)
      await childReachedRefresh(successor.observedFence, successor)
      // The child's mkdir already observed EEXIST. Retire the real owner's
      // fence before allowing its first lstat, without changing the fs result.
      controller.abort()
      expect(await first).toMatchObject({ code: "MCP_AUTH_CANCELLED" })
      successor.child.send("read-released-fence")
      const result = await successor.done
      expect(result.code).toBe(1)
      expect(result.errors).toBe("")
      expect(JSON.parse(result.output), result.output).toMatchObject({
        code: "MCP_AUTH_REAUTH_REQUIRED",
        ownedRead: true,
      })
      expect(f.refreshes).toBe(1)
    } finally {
      controller.abort()
      f.releaseRefresh()
      await first
      if (successor) await stopChild(successor.child)
    }
  })
})

test("two actual processes serialize refresh and reread the winning rotated grant", async () => {
  await withFixture(async (f) => {
    await loginMcp({ ...f.options, onAuthorize: f.authorize })
    await f.expire()
    f.setRefreshMode("hold")
    const first = authChild(f.options)
    let second: ReturnType<typeof authChild> | undefined
    try {
      await childReachedRefresh(f.refreshReceived, first)
      second = authChild(f.options)
      expect(
        await Promise.race([
          second.observedPending.then(() => "pending"),
          second.done.then(() => "finished"),
        ]),
      ).toBe("pending")
      expect(
        await Promise.race([
          second.done.then(() => "finished"),
          new Promise<string>((done) => setTimeout(() => done("waiting"), 800)),
        ]),
      ).toBe("waiting")
      expect(f.refreshes).toBe(1)
      f.releaseRefresh()
      const results = await Promise.all([first.done, second.done])
      expect(results.map((result) => result.code)).toEqual([0, 0])
      expect(results.map((result) => result.errors)).toEqual(["", ""])
      const [left, right] = results
      if (!left || !right) throw new Error("Both child results are required.")
      expect(JSON.parse(left.output)).toEqual(JSON.parse(right.output))
      expect(f.refreshes).toBe(1)
    } finally {
      f.releaseRefresh()
      await stopChild(first.child)
      if (second) await stopChild(second.child)
    }
  })
})

test("a process killed after provider rotation leaves a recoverable fence and an unreplayable refresh marker", async () => {
  await withFixture(async (f) => {
    await loginMcp({ ...f.options, onAuthorize: f.authorize })
    await f.expire()
    f.setRefreshMode("hold")
    const first = authChild(f.options)
    try {
      await childReachedRefresh(f.refreshReceived, first)
      first.child.kill("SIGKILL")
      expect((await first.done).signal).toBe("SIGKILL")
      const successor = authChild(f.options)
      try {
        const result = await successor.done
        expect(result.code).toBe(1)
        expect(JSON.parse(result.output)).toEqual({ code: "MCP_AUTH_REAUTH_REQUIRED" })
        expect(result.errors).toBe("")
      } finally {
        await stopChild(successor.child)
      }
      expect(f.refreshes).toBe(1)
      expect((await getMcpAuthStatus(f.options)).oauth).toBe("reauth_required")
    } finally {
      f.releaseRefresh()
      await stopChild(first.child)
    }
  })
})

test("logout in another process fences a still-listening callback before code exchange", async () => {
  await withFixture(async (f) => {
    const visible = latch<string>()
    const pending = loginMcp({ ...f.options, onAuthorize: presentUntilClosed(visible) }).then(
      () => "success",
      (error: unknown) => error,
    )
    const url = await visible.promise
    const logout = authChild(f.options, "logoutMcp")
    try {
      expect((await logout.done).code).toBe(0)
    } finally {
      await stopChild(logout.child)
    }
    await f.authorize({ url, signal: new AbortController().signal, deadline: Date.now() + 5000 })
    expect(await pending).toMatchObject({ code: "MCP_AUTH_STALE" })
    expect(f.exchanges).toBe(0)
  })
})

test("an expired waiter cannot exchange a callback before its delayed timer runs", async () => {
  await withFixture(async (f) => {
    const visible = latch<string>()
    const currentTime = Date.now
    const pending = loginMcp({
      ...f.options,
      deadline: currentTime() + 10_000,
      onAuthorize: presentUntilClosed(visible),
    }).then(
      (value) => value,
      (error: unknown) => error,
    )
    const url = await visible.promise
    const expired = currentTime() + 11_000
    try {
      Date.now = () => expired
      await f
        .authorize({ url, signal: new AbortController().signal, deadline: expired + 5000 })
        .catch(() => undefined)
      expect(await pending).toMatchObject({ code: "MCP_AUTH_TIMEOUT" })
      expect(f.exchanges).toBe(0)
      expect((await getMcpAuthStatus(f.options)).oauth).toBe("absent")
    } finally {
      Date.now = currentTime
    }
  })
})

test("an expired waiter cannot commit returned tokens before its delayed timer runs", async () => {
  await withFixture(async (f) => {
    const currentTime = Date.now
    const expired = currentTime() + 11_000
    try {
      const result = await loginMcp({
        ...f.options,
        deadline: currentTime() + 10_000,
        onAuthorize: f.authorize,
        resolveIdentity: async () => {
          Date.now = () => expired
          return fixtureIdentity
        },
      }).then(
        (value) => value,
        (error: unknown) => error,
      )
      expect(result).toMatchObject({ code: "MCP_AUTH_TIMEOUT" })
      expect(f.exchanges).toBe(1)
      expect((await getMcpAuthStatus(f.options)).oauth).toBe("absent")
    } finally {
      Date.now = currentTime
    }
  })
})

test("an expired waiter cannot resume while a different live waiter completes the same authorization", async () => {
  await withFixture(async (f) => {
    const a = latch<string>(),
      b = latch<string>()
    const currentTime = Date.now
    const first = loginMcp({
      ...f.options,
      deadline: currentTime() + 10_000,
      onAuthorize: presentUntilClosed(a),
    }).then(
      (value) => value,
      (error: unknown) => error,
    )
    const second = loginMcp({
      ...f.options,
      deadline: currentTime() + 30_000,
      onAuthorize: presentUntilClosed(b),
    }).then(
      (value) => value,
      (error: unknown) => error,
    )
    const [left, right] = await Promise.all([a.promise, b.promise])
    expect(left).toBe(right)
    const expired = currentTime() + 11_000
    try {
      Date.now = () => expired
      await f.authorize({
        url: right,
        signal: new AbortController().signal,
        deadline: expired + 5000,
      })
      expect(await first).toMatchObject({ code: "MCP_AUTH_TIMEOUT" })
      expect(await second).toMatchObject({ oauth: "ready" })
      expect(f.exchanges).toBe(1)
    } finally {
      Date.now = currentTime
    }
  })
})

test("a full flight deadline remains a timeout when its timer precedes the wall clock tick", async () => {
  await withFixture(async (f) => {
    const visible = latch<McpAuthorizationRequest>()
    const currentTime = Date.now
    const currentTimer = globalThis.setTimeout
    let expireFlight: (() => void) | undefined
    function observedTimer<Args extends unknown[]>(
      callback: (...args: Args) => void,
      delay?: number,
      ...args: Args
    ): ReturnType<typeof setTimeout> {
      if (delay !== undefined && delay >= 290_000 && expireFlight === undefined)
        expireFlight = () => callback(...args)
      return currentTimer(callback, delay, ...args)
    }
    globalThis.setTimeout = Object.assign(observedTimer, currentTimer)
    try {
      const pending = loginMcp({
        ...f.options,
        deadline: currentTime() + 360_000,
        onAuthorize: (request) => {
          visible.resolve(request)
          return new Promise<void>((resolve) => {
            request.signal.addEventListener("abort", () => resolve(), { once: true })
          })
        },
      }).then(
        (value) => value,
        (error: unknown) => error,
      )
      const request = await visible.promise
      if (!expireFlight)
        throw new Error("The fixture did not observe the shared flight deadline timer.")
      Date.now = () => request.deadline - 1
      expireFlight()
      const outcome = await pending
      Date.now = currentTime
      await f.authorize(request).catch(() => undefined)
      const status = await getMcpAuthStatus(f.options)
      expect(outcome).toMatchObject({ code: "MCP_AUTH_TIMEOUT" })
      expect(request.signal.aborted).toBe(true)
      expect(f.exchanges).toBe(0)
      expect(status.oauth).toBe("absent")
      expect(status.identity).toBeNull()
    } finally {
      Date.now = currentTime
      globalThis.setTimeout = currentTimer
    }
  })
})
