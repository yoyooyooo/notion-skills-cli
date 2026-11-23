import { randomBytes, randomUUID, timingSafeEqual, createHash } from "node:crypto"
import { createServer } from "node:http"
import { join, resolve } from "node:path"
import { fail, SkillsError } from "./model.ts"
import {
  McpCredentialStore,
  mcpDigest,
  mcpGuard,
  type McpClientRegistration,
  type McpIdentity,
  type McpStoredState,
  type McpStoreOptions,
} from "./notion-mcp-credential-store.ts"
export type { McpIdentity } from "./notion-mcp-credential-store.ts"

export interface McpAuthorizationRequest {
  readonly url: string
  readonly signal: AbortSignal
  readonly deadline: number
}
export interface McpIdentityRequest {
  readonly bearer: string
  readonly serverUrl: string
  readonly signal: AbortSignal
  readonly deadline: number
}
export interface McpAuthOptions {
  readonly configHome?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly profile?: string
  readonly serverUrl?: string
  readonly signal?: AbortSignal
  readonly deadline?: number
  /** Presentation runs concurrently with the callback listener. Resolving means
   * presented; rejecting detaches this waiter. Its signal closes this UI only. */
  readonly onAuthorize?: (request: McpAuthorizationRequest) => Promise<void>
  readonly resolveIdentity?: (request: McpIdentityRequest) => Promise<McpIdentity>
}
export interface McpCredential {
  readonly kind: "token" | "oauth"
  /** Internal transport input. The public SDK never serializes this object. */
  readonly bearer: string
  readonly connectionId: string
  readonly grantEpoch: string
  readonly revision: number
  readonly workspaceId: string
  readonly principalId: string
  readonly assertCurrent: () => Promise<void>
}
export type McpAuthStatus = {
  readonly profile: string
  readonly serverUrl: string
  readonly connectionId: string
  readonly grantEpoch: string
  readonly revision: number
  readonly tokenSource: "environment" | "stored" | "none"
  readonly oauth: "absent" | "ready" | "expired" | "reauth_required"
  readonly registered: boolean
  readonly identity: McpIdentity | null
}
export interface ResolveMcpCredentialOptions extends McpAuthOptions {
  readonly interactive?: boolean
  readonly forceRefresh?: boolean
}
const HOSTED_SERVER = "https://mcp.notion.com/mcp"
const AUTH_BUDGET_MS = 5 * 60_000
const ATTEMPT_BUDGET_MS = 30_000
const EXPIRY_SKEW_MS = 30_000
const authorizationRequired = (code: string, message: string) =>
  fail(code, message, {
    next: {
      argv: ["ntn-skills", "auth", "mcp", "login"],
      reason: "Authorize the hosted Notion MCP connection, then retry content search.",
      read_only: false,
    },
  })
interface AuthContext extends McpStoreOptions {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly onAuthorize: McpAuthOptions["onAuthorize"]
  readonly resolveIdentity: McpAuthOptions["resolveIdentity"]
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw fail(
      "MCP_AUTH_INVALID_RESPONSE",
      "Notion MCP returned an invalid authorization response.",
    )
  return Object.fromEntries(Object.entries(value))
}
function bounded(value: unknown, maximum = 16_384): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > maximum ||
    /[\p{Cc}\p{Cf}]/u.test(value)
  )
    throw fail("MCP_AUTH_INVALID_RESPONSE", "Notion MCP returned an invalid authorization field.")
  return value
}
function token(value: unknown): string {
  const text = bounded(value)
  if (/\s/u.test(text))
    throw fail("MCP_AUTH_INVALID_RESPONSE", "Notion MCP returned an invalid bearer credential.")
  return text
}
function configuredToken(value: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 16_384 || /[\s\p{Cc}\p{Cf}]/u.test(trimmed))
    throw fail("MCP_AUTH_INVALID_TOKEN", "Provide one nonempty Notion MCP token.")
  return trimmed
}
function serverUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw fail("MCP_AUTH_INVALID_ARGUMENT", "Select the hosted Notion MCP endpoint.")
  }
  if (url.username || url.password || url.search || url.hash)
    throw fail(
      "MCP_AUTH_INVALID_ARGUMENT",
      "The Notion MCP endpoint must not contain credentials or parameters.",
    )
  if (
    url.href !== HOSTED_SERVER &&
    !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))
  )
    throw fail(
      "MCP_AUTH_INVALID_ARGUMENT",
      "Only hosted Notion MCP or an explicit loopback test endpoint is supported.",
    )
  return url.href
}
function context(options: McpAuthOptions, budget = AUTH_BUDGET_MS): AuthContext {
  const env = { ...(options.env ?? process.env) }
  const profile = options.profile ?? "default"
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(profile))
    throw fail("MCP_AUTH_INVALID_ARGUMENT", "Select a bounded Notion MCP profile name.")
  const selected =
    options.configHome ??
    env.NTN_SKILLS_CONFIG_HOME ??
    (env.XDG_CONFIG_HOME
      ? join(env.XDG_CONFIG_HOME, "ntn-skills")
      : env.HOME
        ? join(env.HOME, ".config", "ntn-skills")
        : undefined)
  if (!selected)
    throw fail("MCP_AUTH_INVALID_ARGUMENT", "Set an explicit Notion MCP configuration home.")
  const deadline = options.deadline ?? Date.now() + budget
  if (!Number.isSafeInteger(deadline) || deadline < 0)
    throw fail("MCP_AUTH_INVALID_ARGUMENT", "Use an absolute millisecond authorization deadline.")
  mcpGuard(options.signal, deadline)
  return {
    configHome: resolve(selected),
    env,
    profile,
    serverUrl: serverUrl(options.serverUrl ?? HOSTED_SERVER),
    signal: options.signal,
    deadline,
    onAuthorize: options.onAuthorize,
    resolveIdentity: options.resolveIdentity,
  }
}
function explicit(ctx: AuthContext, state: McpStoredState) {
  const fromEnvironment = ctx.env.NOTION_MCP_TOKEN?.trim()
  if (fromEnvironment)
    return { source: "environment" as const, bearer: configuredToken(fromEnvironment) }
  if (state.storedToken !== null)
    return { source: "stored" as const, bearer: configuredToken(state.storedToken) }
  return undefined
}
function epoch(ctx: AuthContext, state: McpStoredState): string {
  const selected = explicit(ctx, state)
  // The connection is a stable slot, not an access-token hash. A separate opaque
  // epoch changes for an explicit environment override without writing in status.
  return selected === undefined
    ? state.grantEpoch
    : mcpDigest(JSON.stringify([state.grantEpoch, "explicit", mcpDigest(selected.bearer)]))
}
function publicStatus(ctx: AuthContext, state: McpStoredState): McpAuthStatus {
  const selected = explicit(ctx, state)
  const oauth = state.oauth
  return {
    profile: ctx.profile,
    serverUrl: ctx.serverUrl,
    connectionId: state.connectionId,
    grantEpoch: epoch(ctx, state),
    revision: state.revision,
    tokenSource: selected?.source ?? "none",
    oauth:
      oauth.kind === "absent"
        ? "absent"
        : oauth.kind === "reauth_required" || oauth.refresh.kind === "pending"
          ? "reauth_required"
          : oauth.expiresAt <= Date.now() + EXPIRY_SKEW_MS
            ? "expired"
            : "ready",
    registered: state.registration !== null,
    // A saved OAuth identity says nothing about a newly supplied explicit token.
    identity: selected === undefined && oauth.kind === "ready" ? oauth.identity : null,
  }
}
export async function getMcpAuthStatus(options: McpAuthOptions = {}): Promise<McpAuthStatus> {
  const ctx = context(options)
  return publicStatus(ctx, await new McpCredentialStore(ctx).read())
}
function retireFlights(key: string): void {
  const flight = flights.get(key)
  if (flight) {
    flight.controller.abort()
    if (flights.get(key) === flight) flights.delete(key)
  }
}
export async function setMcpToken(
  value: string | undefined,
  options: McpAuthOptions = {},
): Promise<McpAuthStatus> {
  const ctx = context(options)
  const selected = value === undefined ? null : configuredToken(value)
  const store = new McpCredentialStore(ctx)
  retireFlights(store.file)
  const state = await store.transaction(async (current, commit) => {
    const next: McpStoredState = {
      ...current,
      storedToken: selected,
      grantEpoch: randomUUID(),
      revision: current.revision + 1,
    }
    await commit(next)
    return next
  })
  return publicStatus(ctx, state)
}
export async function logoutMcp(options: McpAuthOptions = {}): Promise<McpAuthStatus> {
  const ctx = context(options)
  const store = new McpCredentialStore(ctx)
  retireFlights(store.file)
  const state = await store.transaction(async (current, commit) => {
    const next: McpStoredState = {
      ...current,
      grantEpoch: randomUUID(),
      revision: current.revision + 1,
      oauth: { kind: "absent" },
    }
    await commit(next)
    return next
  })
  return publicStatus(ctx, state)
}
function requestSignal(ctx: Pick<AuthContext, "signal" | "deadline">) {
  mcpGuard(ctx.signal, ctx.deadline)
  const controller = new AbortController()
  const abort = () => controller.abort()
  ctx.signal?.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(abort, Math.min(ATTEMPT_BUDGET_MS, ctx.deadline - Date.now()))
  if (ctx.signal?.aborted) controller.abort()
  return {
    signal: controller.signal,
    close() {
      clearTimeout(timer)
      ctx.signal?.removeEventListener("abort", abort)
    },
  }
}
async function jsonRequest(
  ctx: AuthContext,
  url: string,
  body?: URLSearchParams | Record<string, unknown>,
): Promise<unknown> {
  const request = requestSignal(ctx)
  try {
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      credentials: "omit",
      signal: request.signal,
      headers: {
        accept: "application/json",
        ...(body === undefined
          ? {}
          : {
              "content-type":
                body instanceof URLSearchParams
                  ? "application/x-www-form-urlencoded"
                  : "application/json",
            }),
      },
      ...(body === undefined
        ? {}
        : {
            body: body instanceof URLSearchParams ? body.toString() : JSON.stringify(body),
          }),
    })
    const reader = response.body?.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    if (reader) {
      try {
        for (;;) {
          const part = await reader.read()
          if (part.done) break
          size += part.value.byteLength
          if (size > 131_072)
            throw fail(
              "MCP_AUTH_INVALID_RESPONSE",
              "Notion MCP authorization response exceeded its budget.",
            )
          chunks.push(part.value)
        }
      } finally {
        await reader.cancel().catch(() => undefined)
      }
    }
    mcpGuard(ctx.signal, ctx.deadline)
    let raw: unknown
    try {
      raw = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    } catch {
      if (response.status === 403)
        throw fail("MCP_ACCESS_DENIED", "The authorization server denied this request.")
      if (response.status === 429)
        throw fail("MCP_RATE_LIMITED", "The authorization server is rate limited.")
      throw fail("MCP_AUTH_INVALID_RESPONSE", "Notion MCP returned invalid authorization JSON.")
    }
    if (!response.ok) {
      const record: Record<string, unknown> =
        raw !== null && typeof raw === "object" && !Array.isArray(raw) ? object(raw) : {}
      if (record.error === "invalid_grant")
        throw fail(
          "MCP_AUTH_INVALID_GRANT",
          "The saved Notion MCP grant requires authorization again.",
        )
      // Only a parsed OAuth token error from the pinned issuer proves that this
      // request was rejected before a token response. Status alone is not proof:
      // an intermediary may have emitted 403/429 after the issuer consumed RT.
      if (response.status === 400 && record.error === "invalid_scope")
        throw fail(
          "MCP_INSUFFICIENT_SCOPE",
          "The authorization server rejected the requested scope.",
          {
            oauth_error: "invalid_scope",
            oauth_rejected: true,
          },
        )
      if (response.status === 403)
        throw fail(
          record.error === "insufficient_scope" ? "MCP_INSUFFICIENT_SCOPE" : "MCP_ACCESS_DENIED",
          "The authorization server denied this request.",
        )
      if (response.status === 429)
        throw fail("MCP_RATE_LIMITED", "The authorization server is rate limited.")
      throw fail("MCP_AUTH_HTTP_ERROR", "Notion MCP rejected the authorization request.", {
        status: response.status,
      })
    }
    return raw
  } catch (error) {
    mcpGuard(ctx.signal, ctx.deadline)
    if (error instanceof SkillsError) throw error
    throw fail(
      "MCP_AUTH_UNAVAILABLE",
      "Notion MCP authorization did not complete within its network budget.",
    )
  } finally {
    request.close()
  }
}
function endpoint(value: unknown, issuer: string): string {
  const text = bounded(value, 2048)
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw fail("MCP_AUTH_INVALID_RESPONSE", "Invalid Notion MCP authorization endpoint.")
  }
  if (url.origin !== issuer || url.username || url.password || url.hash || url.search)
    throw fail("MCP_AUTH_INVALID_RESPONSE", "The authorization endpoint belongs to another issuer.")
  return url.href
}
function strings(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((part) => typeof part !== "string"))
    throw fail("MCP_AUTH_INVALID_RESPONSE", "Invalid Notion MCP authorization capabilities.")
  return value.filter((part): part is string => typeof part === "string")
}
async function metadata(ctx: AuthContext) {
  const resource = new URL(ctx.serverUrl)
  const protectedResource = object(
    await jsonRequest(
      ctx,
      resource.origin + "/.well-known/oauth-protected-resource" + resource.pathname,
    ),
  )
  if (protectedResource.resource !== ctx.serverUrl)
    throw fail(
      "MCP_AUTH_INVALID_RESPONSE",
      "Notion MCP protected-resource metadata does not match the selected server.",
    )
  const issuers = strings(protectedResource.authorization_servers)
  if (issuers.length !== 1 || issuers[0] !== resource.origin)
    throw fail("MCP_AUTH_INVALID_RESPONSE", "Notion MCP did not advertise its expected issuer.")
  const issuer = resource.origin
  const value = object(await jsonRequest(ctx, issuer + "/.well-known/oauth-authorization-server"))
  if (
    value.issuer !== issuer ||
    !strings(value.code_challenge_methods_supported).includes("S256") ||
    !strings(value.token_endpoint_auth_methods_supported).includes("none") ||
    !strings(value.grant_types_supported).includes("authorization_code") ||
    !strings(value.grant_types_supported).includes("refresh_token") ||
    value.authorization_response_iss_parameter_supported !== true ||
    !strings(protectedResource.scopes_supported).includes("default")
  )
    throw fail(
      "MCP_AUTH_UNSUPPORTED",
      "The server lacks the required Notion MCP OAuth capabilities.",
    )
  return {
    issuer,
    authorizationEndpoint: endpoint(value.authorization_endpoint, issuer),
    tokenEndpoint: endpoint(value.token_endpoint, issuer),
    registrationEndpoint: endpoint(value.registration_endpoint, issuer),
    scope: "default",
  }
}
function checkRegistration(registration: McpClientRegistration, ctx: AuthContext): void {
  const issuer = new URL(ctx.serverUrl).origin
  if (registration.issuer !== issuer || registration.scope !== "default")
    throw fail("MCP_STATE_CORRUPT", "Saved Notion MCP registration belongs to another issuer.")
  endpoint(registration.authorizationEndpoint, issuer)
  endpoint(registration.tokenEndpoint, issuer)
  const redirect = new URL(registration.redirectUri)
  if (
    redirect.protocol !== "http:" ||
    redirect.hostname !== "127.0.0.1" ||
    !redirect.port ||
    redirect.pathname !== "/callback" ||
    redirect.search ||
    redirect.hash ||
    redirect.username ||
    redirect.password
  )
    throw fail("MCP_STATE_CORRUPT", "Saved Notion MCP callback address is invalid.")
}
interface Deferred<A> {
  readonly promise: Promise<A>
  resolve(value: A): void
  reject(error: unknown): void
}
function deferred<A>(): Deferred<A> {
  let fulfill: (value: A) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<A>((yes, no) => {
    fulfill = yes
    reject = no
  })
  // A flight may retire before a waiter attaches to its URL promise.
  void promise.catch(() => undefined)
  return { promise, resolve: (value) => fulfill(value), reject: (error) => reject(error) }
}
function matches(left: string, right: string): boolean {
  const a = Buffer.from(left),
    b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}
async function callbackListener(
  ctx: AuthContext,
  expectedState: string,
  issuer: string,
  requestedRedirect?: string,
) {
  const code = deferred<string>()
  let redirectUri = requestedRedirect ?? ""
  let consumed = false
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/plain; charset=utf-8")
    response.setHeader("cache-control", "no-store")
    response.setHeader("content-security-policy", "default-src 'none'")
    const reject = () => {
      response.writeHead(400).end("The authorization callback was rejected.")
      code.reject(
        fail("MCP_AUTH_CALLBACK_INVALID", "The Notion MCP authorization callback was invalid."),
      )
    }
    try {
      mcpGuard(ctx.signal, ctx.deadline)
      if (request.method !== "GET" || request.headers.host !== new URL(redirectUri).host)
        return reject()
      const url = new URL(request.url ?? "", redirectUri)
      if (url.origin !== new URL(redirectUri).origin) return reject()
      if (url.pathname !== "/callback") {
        response.writeHead(404).end()
        return
      }
      if (consumed) {
        response.writeHead(409).end("This callback was already used.")
        return
      }
      for (const name of ["state", "iss", "code", "error", "resource", "redirect_uri"])
        if (url.searchParams.getAll(name).length > 1) return reject()
      if (
        !matches(url.searchParams.get("state") ?? "", expectedState) ||
        url.searchParams.get("iss") !== issuer ||
        (url.searchParams.has("resource") && url.searchParams.get("resource") !== ctx.serverUrl) ||
        (url.searchParams.has("redirect_uri") &&
          url.searchParams.get("redirect_uri") !== redirectUri)
      )
        return reject()
      if (url.searchParams.has("error") && url.searchParams.has("code")) return reject()
      if (url.searchParams.has("error")) {
        consumed = true
        response.writeHead(200).end("Authorization was not granted. Return to your application.")
        code.reject(fail("MCP_AUTH_DENIED", "Notion MCP authorization was not granted."))
        return
      }
      const authorizationCode = bounded(url.searchParams.get("code"), 4096)
      consumed = true
      response.writeHead(200).end("Authorization received. Return to your application.")
      code.resolve(authorizationCode)
    } catch {
      reject()
    }
  })
  const port = requestedRedirect === undefined ? 0 : Number(new URL(requestedRedirect).port)
  await new Promise<void>((resolvePromise, reject) => {
    const error = () =>
      reject(
        fail("MCP_AUTH_CALLBACK_UNAVAILABLE", "The local OAuth callback listener could not start."),
      )
    server.once("error", error)
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", error)
      const address = server.address()
      if (address === null || typeof address === "string") {
        reject(
          fail(
            "MCP_AUTH_CALLBACK_UNAVAILABLE",
            "The local OAuth callback listener has no bound port.",
          ),
        )
        return
      }
      redirectUri = "http://127.0.0.1:" + address.port + "/callback"
      resolvePromise()
    })
  })
  server.on("error", () =>
    code.reject(fail("MCP_AUTH_CALLBACK_UNAVAILABLE", "The local OAuth callback listener failed.")),
  )
  const abort = () => {
    try {
      mcpGuard(ctx.signal, ctx.deadline)
    } catch (error) {
      code.reject(error)
    }
  }
  ctx.signal?.addEventListener("abort", abort, { once: true })
  if (ctx.signal?.aborted) abort()
  return {
    redirectUri,
    code: code.promise,
    async close() {
      ctx.signal?.removeEventListener("abort", abort)
      await new Promise<void>((done) => {
        const timer = setTimeout(() => server.closeAllConnections(), 100)
        server.close(() => {
          clearTimeout(timer)
          done()
        })
      })
    },
  }
}
function verifiedIdentity(value: McpIdentity): McpIdentity {
  return {
    workspaceId: bounded(value.workspaceId, 200),
    principalId: bounded(value.principalId, 200),
  }
}
async function verifyIdentity(ctx: AuthContext, bearer: string): Promise<McpIdentity> {
  if (!ctx.resolveIdentity)
    throw fail(
      "MCP_AUTH_IDENTITY_REQUIRED",
      "A verified Notion MCP workspace and principal are required.",
    )
  mcpGuard(ctx.signal, ctx.deadline)
  const request = requestSignal(ctx)
  try {
    const resolver = ctx.resolveIdentity
    const value = await new Promise<McpIdentity>((resolvePromise, reject) => {
      const aborted = () =>
        reject(fail("MCP_AUTH_TIMEOUT", "Notion MCP identity verification was interrupted."))
      request.signal.addEventListener("abort", aborted, { once: true })
      void Promise.resolve()
        .then(() =>
          resolver({
            bearer,
            serverUrl: ctx.serverUrl,
            signal: request.signal,
            deadline: ctx.deadline,
          }),
        )
        .then(resolvePromise, reject)
        .finally(() => request.signal.removeEventListener("abort", aborted))
      if (request.signal.aborted) aborted()
    })
    const identity = verifiedIdentity(value)
    mcpGuard(ctx.signal, ctx.deadline)
    if (request.signal.aborted)
      throw fail("MCP_AUTH_TIMEOUT", "Notion MCP identity verification exceeded its deadline.")
    return identity
  } catch (error) {
    mcpGuard(ctx.signal, ctx.deadline)
    if (error instanceof SkillsError) throw error
    throw fail(
      "MCP_AUTH_IDENTITY_REQUIRED",
      "Notion MCP workspace and principal could not be verified.",
    )
  } finally {
    request.close()
  }
}
function tokenResponse(raw: unknown, ctx: AuthContext, previousIdentity?: McpIdentity) {
  const value = object(raw)
  if (typeof value.token_type !== "string" || value.token_type.toLowerCase() !== "bearer")
    throw fail("MCP_AUTH_INVALID_RESPONSE", "Notion MCP did not return a bearer access token.")
  const expiresIn = value.expires_in
  if (
    typeof expiresIn !== "number" ||
    !Number.isSafeInteger(expiresIn) ||
    expiresIn <= 0 ||
    expiresIn > 31_536_000
  )
    throw fail(
      "MCP_AUTH_INVALID_RESPONSE",
      "Notion MCP did not return a valid access-token lifetime.",
    )
  if (value.resource !== undefined && value.resource !== ctx.serverUrl)
    throw fail("MCP_AUTH_INVALID_RESPONSE", "The OAuth token targets another resource.")
  const hasWorkspace = value.workspace_id !== undefined,
    hasUser = value.user_id !== undefined
  if (hasWorkspace !== hasUser)
    throw fail(
      "MCP_AUTH_INVALID_RESPONSE",
      "The OAuth response contains incomplete identity fields.",
    )
  const claimedIdentity = hasWorkspace
    ? { workspaceId: bounded(value.workspace_id, 200), principalId: bounded(value.user_id, 200) }
    : undefined
  if (
    claimedIdentity &&
    previousIdentity &&
    (claimedIdentity.workspaceId !== previousIdentity.workspaceId ||
      claimedIdentity.principalId !== previousIdentity.principalId)
  )
    throw fail(
      "MCP_AUTH_IDENTITY_MISMATCH",
      "The OAuth response changed the selected workspace or principal.",
    )
  return {
    accessToken: token(value.access_token),
    refreshToken: token(value.refresh_token),
    expiresAt: Date.now() + expiresIn * 1000,
    scope: (() => {
      const scope = value.scope === undefined ? "default" : bounded(value.scope, 2048)
      if (scope !== "default")
        throw fail("MCP_AUTH_INVALID_RESPONSE", "The OAuth scope differs from the requested scope.")
      return scope
    })(),
    claimedIdentity,
  }
}
interface AuthFlight {
  readonly controller: AbortController
  readonly deadline: number
  readonly waiters: Map<
    symbol,
    { readonly signal: AbortSignal | undefined; readonly deadline: number }
  >
  readonly url: Deferred<string>
  readonly result: Deferred<void>
}
function hasLiveAuthorizationOwner(flight: AuthFlight): boolean {
  for (const waiter of flight.waiters.values()) {
    if (!waiter.signal?.aborted && waiter.deadline > Date.now()) return true
  }
  return false
}
function presentationError(error: unknown): SkillsError {
  const code =
    error !== null && typeof error === "object" && "code" in error ? error.code : undefined
  switch (code) {
    case "MCP_AUTH_TIMEOUT":
      return fail(code, "The authorization presentation reached its deadline.")
    case "MCP_AUTH_INTERACTION_REQUIRED":
      return authorizationRequired(
        code,
        "Interactive authorization is unavailable; run auth mcp login from an interactive terminal.",
      )
    case "MCP_AUTH_BROWSER_UNAVAILABLE":
      return fail(code, "The browser could not open the Notion MCP authorization page.")
    case "MCP_AUTH_DENIED":
      return fail(code, "Notion MCP authorization was declined.")
    default:
      return fail("MCP_AUTH_CANCELLED", "This authorization presentation was closed.")
  }
}
const flights = new Map<string, AuthFlight>()
async function authorize(ctx: AuthContext, flight: AuthFlight): Promise<void> {
  const live = () => {
    mcpGuard(ctx.signal, ctx.deadline)
    if (flight.waiters.size === 0)
      throw fail("MCP_AUTH_CANCELLED", "No caller is waiting for this authorization.")
    if (!hasLiveAuthorizationOwner(flight))
      throw fail("MCP_AUTH_TIMEOUT", "No authorization caller has an unexpired deadline.")
  }
  const store = new McpCredentialStore({ ...ctx, beforePublish: live })
  let listener: Awaited<ReturnType<typeof callbackListener>> | undefined
  try {
    live()
    if (!ctx.resolveIdentity)
      throw fail(
        "MCP_AUTH_IDENTITY_REQUIRED",
        "A verified Notion MCP workspace and principal are required.",
      )
    const selected = await store.transaction(async (current, commit) => {
      live()
      if (explicit(ctx, current))
        throw fail(
          "MCP_AUTH_TOKEN_ACTIVE",
          "Remove NOTION_MCP_TOKEN or clear the stored MCP token before OAuth login.",
        )
      const next: McpStoredState = {
        ...current,
        grantEpoch: randomUUID(),
        revision: current.revision + 1,
        oauth: { kind: "absent" },
      }
      await commit(next)
      return next
    })
    const expectedEpoch = selected.grantEpoch
    const fence = async () => {
      live()
      const state = await store.read()
      if (state.grantEpoch !== expectedEpoch)
        throw fail("MCP_AUTH_STALE", "The Notion MCP connection changed during authorization.")
      return state
    }
    const discovery = await metadata(ctx)
    let client = selected.registration
    if (client !== null) {
      checkRegistration(client, ctx)
      if (
        client.authorizationEndpoint !== discovery.authorizationEndpoint ||
        client.tokenEndpoint !== discovery.tokenEndpoint
      )
        throw fail(
          "MCP_AUTH_UNSUPPORTED",
          "Saved registration no longer matches the issuer metadata.",
        )
    }
    const state = randomBytes(32).toString("base64url")
    const verifier = randomBytes(48).toString("base64url")
    listener = await callbackListener(ctx, state, discovery.issuer, client?.redirectUri)
    if (client === null) {
      await fence()
      const response = object(
        await jsonRequest(ctx, discovery.registrationEndpoint, {
          client_name: "ntn-skills",
          redirect_uris: [listener.redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          scope: discovery.scope,
        }),
      )
      if (
        response.token_endpoint_auth_method !== undefined &&
        response.token_endpoint_auth_method !== "none"
      )
        throw fail(
          "MCP_AUTH_UNSUPPORTED",
          "The registered client requires an unsupported authentication method.",
        )
      if (response.client_secret !== undefined)
        throw fail("MCP_AUTH_UNSUPPORTED", "The public MCP client cannot accept a client secret.")
      if (
        response.redirect_uris !== undefined &&
        (strings(response.redirect_uris).length !== 1 ||
          strings(response.redirect_uris)[0] !== listener.redirectUri)
      )
        throw fail(
          "MCP_AUTH_INVALID_RESPONSE",
          "The registered callback differs from the requested redirect.",
        )
      client = {
        issuer: discovery.issuer,
        clientId: bounded(response.client_id, 2048),
        authorizationEndpoint: discovery.authorizationEndpoint,
        tokenEndpoint: discovery.tokenEndpoint,
        redirectUri: listener.redirectUri,
        scope: discovery.scope,
      }
      const registered = client
      await store.transaction(async (current, commit) => {
        live()
        if (current.grantEpoch !== expectedEpoch)
          throw fail(
            "MCP_AUTH_STALE",
            "The connection changed before client registration was saved.",
          )
        await commit({ ...current, registration: registered, revision: current.revision + 1 })
      })
    }
    const url = new URL(client.authorizationEndpoint)
    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: client.redirectUri,
      scope: client.scope,
      state,
      resource: ctx.serverUrl,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    }))
      url.searchParams.set(key, value)
    await fence()
    flight.url.resolve(url.href)
    const code = await listener.code
    // Code exchange is a side effect; stale callbacks are rejected before dispatch.
    await fence()
    const registeredClient = client
    const response = await store.transaction(async (current) => {
      live()
      if (current.grantEpoch !== expectedEpoch)
        throw fail("MCP_AUTH_STALE", "The connection changed before code exchange.")
      return tokenResponse(
        await jsonRequest(
          ctx,
          registeredClient.tokenEndpoint,
          new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id: registeredClient.clientId,
            redirect_uri: registeredClient.redirectUri,
            code_verifier: verifier,
            resource: ctx.serverUrl,
          }),
        ),
        ctx,
      )
    })
    const identity = await verifyIdentity(ctx, response.accessToken)
    if (
      response.claimedIdentity &&
      (response.claimedIdentity.workspaceId !== identity.workspaceId ||
        response.claimedIdentity.principalId !== identity.principalId)
    )
      throw fail(
        "MCP_AUTH_IDENTITY_MISMATCH",
        "The OAuth grant and verified Notion MCP identity differ.",
      )
    await store.transaction(async (current, commit) => {
      live()
      if (current.grantEpoch !== expectedEpoch)
        throw fail("MCP_AUTH_STALE", "The connection changed before the OAuth grant was saved.")
      await commit({
        ...current,
        revision: current.revision + 1,
        oauth: {
          kind: "ready",
          accessToken: response.accessToken,
          refreshToken: response.refreshToken,
          expiresAt: response.expiresAt,
          scope: response.scope,
          identity,
          refresh: { kind: "idle" },
        },
      })
    })
  } finally {
    await listener?.close()
  }
}
async function waitForFlight(ctx: AuthContext): Promise<void> {
  if (!ctx.onAuthorize)
    throw authorizationRequired(
      "MCP_AUTH_REQUIRED",
      "Authorize Notion MCP with auth mcp login before using content search.",
    )
  const store = new McpCredentialStore(ctx)
  let flight = flights.get(store.file)
  let start = false
  if (flight === undefined || flight.controller.signal.aborted) {
    flight = {
      controller: new AbortController(),
      deadline: Date.now() + AUTH_BUDGET_MS,
      waiters: new Map(),
      url: deferred<string>(),
      result: deferred<void>(),
    }
    flights.set(store.file, flight)
    start = true
  }
  const selected = flight
  const owner = Symbol("mcp-auth-waiter")
  const deadline = Math.min(ctx.deadline, selected.deadline)
  selected.waiters.set(owner, { signal: ctx.signal, deadline })
  if (start) {
    const flightContext: AuthContext = {
      ...ctx,
      signal: selected.controller.signal,
      deadline: selected.deadline,
    }
    const timer = setTimeout(() => selected.controller.abort(), selected.deadline - Date.now())
    void authorize(flightContext, selected)
      .then(
        () => selected.result.resolve(),
        (error: unknown) => {
          const safe =
            error instanceof SkillsError
              ? error
              : fail("MCP_AUTH_UNAVAILABLE", "Notion MCP authorization could not complete.")
          selected.url.reject(safe)
          selected.result.reject(safe)
        },
      )
      .finally(() => {
        clearTimeout(timer)
        selected.controller.abort()
        if (flights.get(store.file) === selected) flights.delete(store.file)
      })
  }
  const presentation = new AbortController()
  const detached = deferred<never>()
  const cancel = () =>
    detached.reject(fail("MCP_AUTH_CANCELLED", "This authorization request was cancelled."))
  ctx.signal?.addEventListener("abort", cancel, { once: true })
  const timer = setTimeout(
    () =>
      detached.reject(fail("MCP_AUTH_TIMEOUT", "This authorization request reached its deadline.")),
    Math.max(1, deadline - Date.now()),
  )
  if (ctx.signal?.aborted) cancel()
  const present = selected.url.promise.then(async (url) => {
    mcpGuard(ctx.signal, deadline)
    await ctx.onAuthorize?.({ url, signal: presentation.signal, deadline })
  })
  // Presentation resolution is not authorization. Rejection retires this owner,
  // without cancelling another foreground search or an explicit CLI owner.
  void present.catch((error: unknown) => detached.reject(presentationError(error)))
  try {
    await Promise.race([selected.result.promise, detached.promise])
    mcpGuard(ctx.signal, deadline)
  } finally {
    clearTimeout(timer)
    ctx.signal?.removeEventListener("abort", cancel)
    presentation.abort()
    selected.waiters.delete(owner)
    if (selected.waiters.size === 0) selected.controller.abort()
  }
}
export async function loginMcp(options: McpAuthOptions = {}): Promise<McpAuthStatus> {
  const ctx = context(options)
  if (explicit(ctx, await new McpCredentialStore(ctx).read()))
    throw fail(
      "MCP_AUTH_TOKEN_ACTIVE",
      "Remove NOTION_MCP_TOKEN or clear the stored MCP token before OAuth login.",
    )
  await waitForFlight(ctx)
  return publicStatus(ctx, await new McpCredentialStore(ctx).read())
}
async function refreshGrant(ctx: AuthContext, observed: McpStoredState, force: boolean) {
  const store = new McpCredentialStore(ctx)
  return store.transaction(async (current, commit) => {
    mcpGuard(ctx.signal, ctx.deadline)
    if (current.grantEpoch !== observed.grantEpoch || explicit(ctx, current))
      throw fail("MCP_AUTH_STALE", "The Notion MCP credential changed before refresh.")
    const grant = current.oauth
    if (grant.kind !== "ready" || grant.refresh.kind !== "idle")
      throw authorizationRequired(
        "MCP_AUTH_REAUTH_REQUIRED",
        "An incomplete or invalid refresh requires authorization again.",
      )
    if (
      (!force || current.revision !== observed.revision) &&
      grant.expiresAt > Date.now() + EXPIRY_SKEW_MS
    )
      return current
    const client = current.registration
    if (client === null)
      throw fail("MCP_STATE_CORRUPT", "The OAuth grant has no registered client.")
    checkRegistration(client, ctx)
    const requestId = randomUUID()
    const marked: McpStoredState = {
      ...current,
      oauth: {
        ...grant,
        refresh: {
          kind: "pending",
          requestId,
          revision: current.revision,
          grantEpoch: current.grantEpoch,
          startedAt: Date.now(),
          deadline: ctx.deadline,
        },
      },
    }
    // This must finish file and directory fsync before the refresh token is sent.
    await commit(marked)
    mcpGuard(ctx.signal, ctx.deadline)
    try {
      const response = tokenResponse(
        await jsonRequest(
          ctx,
          client.tokenEndpoint,
          new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: grant.refreshToken,
            client_id: client.clientId,
            resource: ctx.serverUrl,
          }),
        ),
        ctx,
        grant.identity,
      )
      if (response.refreshToken === grant.refreshToken)
        throw fail(
          "MCP_AUTH_INVALID_RESPONSE",
          "The refresh response did not rotate its refresh token.",
        )
      mcpGuard(ctx.signal, ctx.deadline)
      const latest = await store.read()
      if (
        latest.grantEpoch !== current.grantEpoch ||
        latest.revision !== current.revision ||
        latest.oauth.kind !== "ready" ||
        latest.oauth.refresh.kind !== "pending" ||
        latest.oauth.refresh.requestId !== requestId
      )
        throw fail("MCP_AUTH_STALE", "The saved refresh transaction changed before commit.")
      const next: McpStoredState = {
        ...latest,
        revision: latest.revision + 1,
        oauth: {
          kind: "ready",
          accessToken: response.accessToken,
          refreshToken: response.refreshToken,
          expiresAt: response.expiresAt,
          scope: response.scope,
          identity: grant.identity,
          refresh: { kind: "idle" },
        },
      }
      await commit(next)
      return next
    } catch (error) {
      // The durable marker remains on timeout, cancellation, malformed success,
      // lost response and process death. No successor replays the old token.
      if (error instanceof SkillsError && error.code === "MCP_AUTH_INVALID_GRANT") {
        await commit({
          ...marked,
          revision: marked.revision + 1,
          oauth: { kind: "reauth_required", reason: "invalid_grant" },
        })
      }
      if (
        error instanceof SkillsError &&
        error.code === "MCP_INSUFFICIENT_SCOPE" &&
        error.details !== null &&
        typeof error.details === "object" &&
        "oauth_rejected" in error.details &&
        error.details.oauth_rejected === true
      ) {
        // A definite OAuth invalid_scope response issues no new tokens. Restore
        // the same grant, with no automatic retry or browser authorization.
        await commit(current)
        throw error
      }
      mcpGuard(ctx.signal, ctx.deadline)
      if (error instanceof SkillsError && error.code === "MCP_AUTH_STALE") throw error
      if (
        error instanceof SkillsError &&
        ["MCP_ACCESS_DENIED", "MCP_RATE_LIMITED", "MCP_INSUFFICIENT_SCOPE"].includes(error.code)
      )
        throw error
      throw authorizationRequired(
        "MCP_AUTH_REAUTH_REQUIRED",
        "The refresh did not produce a safely saved grant; authorize Notion MCP again.",
      )
    }
  })
}
function credential(
  ctx: AuthContext,
  state: McpStoredState,
  kind: "token" | "oauth",
  bearer: string,
  identity: McpIdentity,
): McpCredential {
  const selectedEpoch = epoch(ctx, state)
  return {
    kind,
    bearer,
    connectionId: state.connectionId,
    grantEpoch: selectedEpoch,
    revision: state.revision,
    ...identity,
    assertCurrent: async () => {
      mcpGuard(ctx.signal, ctx.deadline)
      const current = await new McpCredentialStore(ctx).read()
      if (current.connectionId !== state.connectionId || epoch(ctx, current) !== selectedEpoch)
        throw fail("MCP_AUTH_STALE", "The Notion MCP credential changed during this operation.")
      if (
        kind === "oauth" &&
        (current.oauth.kind !== "ready" ||
          current.oauth.refresh.kind !== "idle" ||
          current.oauth.identity.workspaceId !== identity.workspaceId ||
          current.oauth.identity.principalId !== identity.principalId)
      )
        throw fail(
          "MCP_AUTH_STALE",
          "The Notion MCP grant is no longer eligible for this operation.",
        )
    },
  }
}
export async function resolveMcpCredential(
  options: ResolveMcpCredentialOptions = {},
): Promise<McpCredential> {
  const ctx = context(options)
  const store = new McpCredentialStore(ctx)
  let state = await store.read()
  const initialRevision = state.revision
  const selected = explicit(ctx, state)
  if (selected !== undefined) {
    const identity = await verifyIdentity(ctx, selected.bearer).catch((error: unknown) => {
      if (error instanceof SkillsError && error.code === "MCP_AUTH_REQUIRED")
        throw fail(
          "MCP_AUTH_INVALID_TOKEN",
          "The explicit Notion MCP token was rejected. Replace or clear that token.",
        )
      throw error
    })
    const resolved = credential(ctx, state, "token", selected.bearer, identity)
    await resolved.assertCurrent()
    return resolved
  }
  if (state.oauth.kind === "ready" && state.oauth.refresh.kind === "pending") {
    const observedEpoch = state.grantEpoch
    // A marker can belong to a live refresher. Wait on its fence before deciding
    // whether this is a committed rotation or an abandoned transaction.
    state = await store.transaction(async (current) => {
      if (current.grantEpoch !== observedEpoch || explicit(ctx, current))
        throw fail("MCP_AUTH_STALE", "The Notion MCP credential changed while waiting for refresh.")
      return current
    })
  }
  if (state.oauth.kind !== "ready" || state.oauth.refresh.kind !== "idle") {
    if (
      (state.oauth.kind === "ready" && state.oauth.refresh.kind === "pending") ||
      (state.oauth.kind === "reauth_required" && state.oauth.reason === "uncertain_refresh")
    )
      throw authorizationRequired(
        "MCP_AUTH_REAUTH_REQUIRED",
        "An uncertain refresh requires explicit auth mcp login; it cannot start authorization automatically.",
      )
    if (!options.interactive)
      throw authorizationRequired(
        state.oauth.kind === "absent" ? "MCP_AUTH_REQUIRED" : "MCP_AUTH_REAUTH_REQUIRED",
        "Authorize Notion MCP with auth mcp login before using content search.",
      )
    await waitForFlight(ctx)
    state = await store.read()
  }
  if (state.oauth.kind !== "ready" || state.oauth.refresh.kind !== "idle")
    throw authorizationRequired("MCP_AUTH_REAUTH_REQUIRED", "The Notion MCP grant is unavailable.")
  const forceRefresh = options.forceRefresh === true && state.revision === initialRevision
  if (forceRefresh || state.oauth.expiresAt <= Date.now() + EXPIRY_SKEW_MS)
    state = await refreshGrant(ctx, state, forceRefresh)
  if (state.oauth.kind !== "ready" || state.oauth.refresh.kind !== "idle")
    throw authorizationRequired("MCP_AUTH_REAUTH_REQUIRED", "The Notion MCP grant is unavailable.")
  const resolved = credential(ctx, state, "oauth", state.oauth.accessToken, state.oauth.identity)
  await resolved.assertCurrent()
  return resolved
}
