import { constants } from "node:fs"
import { lstat, mkdir, open, rename } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { dirname, join, resolve } from "node:path"
import { Cause, Effect, Exit, Option } from "effect"
import { withLocalLocks } from "./local-locks.ts"
import { fail, SkillsError } from "./model.ts"

export interface McpIdentity {
  readonly workspaceId: string
  readonly principalId: string
}
export interface McpClientRegistration {
  readonly issuer: string
  readonly clientId: string
  readonly authorizationEndpoint: string
  readonly tokenEndpoint: string
  readonly redirectUri: string
  readonly scope: string
}
export type McpRefreshState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "pending"
      readonly requestId: string
      readonly revision: number
      readonly grantEpoch: string
      readonly startedAt: number
      readonly deadline: number
    }
export type McpStoredOAuth =
  | { readonly kind: "absent" }
  | { readonly kind: "reauth_required"; readonly reason: "invalid_grant" | "uncertain_refresh" }
  | {
      readonly kind: "ready"
      readonly accessToken: string
      readonly refreshToken: string
      readonly expiresAt: number
      readonly scope: string
      readonly identity: McpIdentity
      readonly refresh: McpRefreshState
    }
export interface McpStoredState {
  readonly version: 1
  readonly profile: string
  readonly serverUrl: string
  readonly connectionId: string
  readonly grantEpoch: string
  readonly revision: number
  /** An explicit bearer overrides, but never destroys, the saved OAuth grant. */
  readonly storedToken: string | null
  readonly registration: McpClientRegistration | null
  readonly oauth: McpStoredOAuth
}
export interface McpStoreOptions {
  readonly configHome: string
  readonly profile: string
  readonly serverUrl: string
  readonly signal?: AbortSignal
  readonly deadline: number
  readonly beforePublish?: () => void
}

export const mcpDigest = (value: string) => createHash("sha256").update(value).digest("hex")
export function mcpGuard(signal: AbortSignal | undefined, deadline: number): void {
  if (Date.now() >= deadline)
    throw fail("MCP_AUTH_TIMEOUT", "The Notion MCP authorization deadline was reached.")
  if (signal?.aborted) throw fail("MCP_AUTH_CANCELLED", "Notion MCP authorization was cancelled.")
}
export function mcpSafeError(error: unknown): SkillsError {
  return error instanceof SkillsError
    ? error
    : fail("MCP_STORAGE_ERROR", "The private Notion MCP credential store could not be accessed.")
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw fail("MCP_STATE_CORRUPT", "Invalid Notion MCP credential state.")
  return value
}
function field(value: unknown, maximum = 16_384): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > maximum ||
    /[\p{Cc}\p{Cf}]/u.test(value)
  )
    throw fail("MCP_STATE_CORRUPT", "Invalid Notion MCP credential state.")
  return value
}
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw fail("MCP_STATE_CORRUPT", "Invalid Notion MCP credential state.")
  return value
}
function secret(value: unknown): string {
  const text = field(value)
  if (/\s/u.test(text)) throw fail("MCP_STATE_CORRUPT", "Invalid Notion MCP credential state.")
  return text
}
function scope(value: unknown): string {
  if (value !== "default") throw fail("MCP_STATE_CORRUPT", "Invalid Notion MCP credential scope.")
  return value
}
function identity(input: unknown): McpIdentity {
  const value = object(input)
  return { workspaceId: field(value.workspaceId, 200), principalId: field(value.principalId, 200) }
}
function registration(input: unknown): McpClientRegistration | null {
  if (input === null) return null
  const value = object(input)
  return {
    issuer: field(value.issuer, 2048),
    clientId: field(value.clientId, 2048),
    authorizationEndpoint: field(value.authorizationEndpoint, 2048),
    tokenEndpoint: field(value.tokenEndpoint, 2048),
    redirectUri: field(value.redirectUri, 2048),
    scope: scope(value.scope),
  }
}
function refresh(input: unknown): McpRefreshState {
  const value = object(input)
  if (value.kind === "idle") return { kind: "idle" }
  if (value.kind !== "pending")
    throw fail("MCP_STATE_CORRUPT", "Invalid refresh transaction state.")
  return {
    kind: "pending",
    requestId: field(value.requestId, 200),
    revision: number(value.revision),
    grantEpoch: field(value.grantEpoch, 200),
    startedAt: number(value.startedAt),
    deadline: number(value.deadline),
  }
}
function oauth(input: unknown): McpStoredOAuth {
  const value = object(input)
  if (value.kind === "absent") return { kind: "absent" }
  if (value.kind === "reauth_required") {
    if (value.reason !== "invalid_grant" && value.reason !== "uncertain_refresh")
      throw fail("MCP_STATE_CORRUPT", "Invalid refresh recovery state.")
    return { kind: "reauth_required", reason: value.reason }
  }
  if (value.kind !== "ready") throw fail("MCP_STATE_CORRUPT", "Invalid OAuth grant state.")
  return {
    kind: "ready",
    accessToken: secret(value.accessToken),
    refreshToken: secret(value.refreshToken),
    expiresAt: number(value.expiresAt),
    scope: scope(value.scope),
    identity: identity(value.identity),
    refresh: refresh(value.refresh),
  }
}
export function decodeMcpStoredState(input: unknown): McpStoredState {
  const value = object(input)
  if (value.version !== 1) throw fail("MCP_STATE_CORRUPT", "Unsupported MCP credential format.")
  return {
    version: 1,
    profile: field(value.profile, 64),
    serverUrl: field(value.serverUrl, 2048),
    connectionId: field(value.connectionId, 200),
    grantEpoch: field(value.grantEpoch, 200),
    revision: number(value.revision),
    storedToken: value.storedToken === null ? null : secret(value.storedToken),
    registration: registration(value.registration),
    oauth: oauth(value.oauth),
  }
}
async function pause(signal: AbortSignal | undefined, deadline: number): Promise<void> {
  mcpGuard(signal, deadline)
  await new Promise<void>((resolvePromise, reject) => {
    const finish = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", cancel)
      resolvePromise()
    }
    const cancel = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", cancel)
      reject(fail("MCP_AUTH_CANCELLED", "Notion MCP authorization was cancelled."))
    }
    const timer = setTimeout(finish, Math.min(25, Math.max(1, deadline - Date.now())))
    signal?.addEventListener("abort", cancel, { once: true })
    if (signal?.aborted) cancel()
  })
}

/** One machine, one profile file, one matching cross-process fence.
 * No REST Store, SQLite runtime, external keychain or personal CLI login is read. */
export class McpCredentialStore {
  readonly options: McpStoreOptions
  readonly directory: string
  readonly file: string
  readonly key: string
  constructor(options: McpStoreOptions) {
    this.options = options
    this.key = mcpDigest(JSON.stringify([options.serverUrl, options.profile]))
    this.directory = join(resolve(options.configHome), "notion-mcp", this.key)
    this.file = join(this.directory, "credentials.json")
  }
  private initial(): McpStoredState {
    return {
      version: 1,
      profile: this.options.profile,
      serverUrl: this.options.serverUrl,
      connectionId: mcpDigest(JSON.stringify([resolve(this.options.configHome), this.key])),
      grantEpoch: "unconfigured",
      revision: 0,
      storedToken: null,
      registration: null,
      oauth: { kind: "absent" },
    }
  }
  private async prepare(): Promise<void> {
    mcpGuard(this.options.signal, this.options.deadline)
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const info = await lstat(this.directory)
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
      throw fail("MCP_STATE_UNSAFE", "The MCP credential directory must be private.")
  }
  async read(): Promise<McpStoredState> {
    mcpGuard(this.options.signal, this.options.deadline)
    try {
      const handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const info = await handle.stat()
        if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 131_072)
          throw fail("MCP_STATE_UNSAFE", "The MCP credential file must be private and bounded.")
        const contents = await handle.readFile("utf8")
        mcpGuard(this.options.signal, this.options.deadline)
        let raw: unknown
        try {
          raw = JSON.parse(contents)
        } catch {
          throw fail("MCP_STATE_CORRUPT", "The MCP credential file is not valid JSON.")
        }
        const state = decodeMcpStoredState(raw)
        if (state.profile !== this.options.profile || state.serverUrl !== this.options.serverUrl)
          throw fail("MCP_STATE_CORRUPT", "The MCP credential file belongs to another connection.")
        return state
      } finally {
        await handle.close()
      }
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return this.initial()
      throw mcpSafeError(error)
    }
  }
  private async publish(state: McpStoredState): Promise<void> {
    mcpGuard(this.options.signal, this.options.deadline)
    const staged = join(this.directory, `credentials.${randomUUID()}.pending`)
    const handle = await open(
      staged,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      await handle.writeFile(JSON.stringify(state) + "\n")
      await handle.sync()
    } finally {
      await handle.close()
    }
    // Keep a failed private staging file for inspection; never overwrite a newer
    // grant after this caller's cancellation/deadline.
    mcpGuard(this.options.signal, this.options.deadline)
    this.options.beforePublish?.()
    await rename(staged, this.file)
    let directory = this.directory
    for (;;) {
      const handle = await open(directory, constants.O_RDONLY)
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  async transaction<A>(
    operation: (
      state: McpStoredState,
      commit: (next: McpStoredState) => Promise<void>,
    ) => Promise<A>,
  ): Promise<A> {
    await this.prepare().catch((error: unknown) => {
      throw mcpSafeError(error)
    })
    for (;;) {
      mcpGuard(this.options.signal, this.options.deadline)
      // Cancellation belongs to the awaited transaction itself. Interrupting an
      // Effect wrapper around an arbitrary Promise would release the fence while
      // its callback was still running.
      const result = await Effect.runPromiseExit(
        withLocalLocks(
          this.directory,
          ["notion-mcp-credentials"],
          Effect.tryPromise({
            try: async () => {
              const state = await this.read()
              return operation(state, (next) => this.publish(next))
            },
            catch: mcpSafeError,
          }),
        ),
      )
      if (Exit.isSuccess(result)) return result.value
      const error = Option.getOrUndefined(Cause.findErrorOption(result.cause))
      if (error instanceof SkillsError && error.code === "SYNC_LOCKED") {
        await pause(this.options.signal, this.options.deadline)
        continue
      }
      throw mcpSafeError(error)
    }
  }
}
