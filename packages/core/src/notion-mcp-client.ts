import { Buffer } from "node:buffer"
import { fail, SkillsError } from "./model.ts"

// Hosted Notion's July protocol uses independent POSTs, not an initialize session.
export const NOTION_MCP_PROTOCOL_VERSION = "2026-07-28"
export const NOTION_MCP_ENDPOINT = "https://mcp.notion.com/mcp"

export type NotionMcpBudgets = {
  readonly timeoutMs?: number
  readonly attemptTimeoutMs?: number
  readonly maxRequests?: number
  readonly maxListPages?: number
  readonly maxResponseBytes?: number
  readonly maxTotalBytes?: number
  readonly maxTools?: number
  readonly maxEvents?: number
  readonly maxRateLimitRetries?: number
  readonly maxRetryDelayMs?: number
}

export type NotionMcpOptions = {
  readonly bearer: string
  readonly serverUrl?: string
  readonly signal?: AbortSignal
  readonly deadline?: number
  readonly budgets?: NotionMcpBudgets
}

export type NotionMcpIdentity = {
  readonly workspaceId: string
  readonly principalId: string
}

export type NotionMcpSearchMatch = {
  readonly pageId: string
  readonly title?: string
  readonly snippet?: string
  readonly url?: string
}

export type NotionMcpSearchResult = {
  readonly matches: readonly NotionMcpSearchMatch[]
  readonly notices: readonly { readonly kind: "remote_notice"; readonly count: number }[]
  readonly exhaustive: false
}

export type NotionMcpSearchOptions = NotionMcpOptions & {
  readonly query: string
  readonly pageSize?: number
  readonly pageUrl?: string
  readonly dataSourceUrl?: string
}

type JsonObject = Record<string, unknown>
type HeaderParameter = {
  readonly path: readonly string[]
  readonly name: string
  readonly type: "string" | "integer" | "boolean"
}
type Tool = {
  readonly name: string
  readonly inputSchema: JsonObject
  readonly headers: readonly HeaderParameter[]
}
type Limits = Required<NotionMcpBudgets>

const DEFAULT_LIMITS: Limits = {
  timeoutMs: 30_000,
  attemptTimeoutMs: 15_000,
  maxRequests: 16,
  maxListPages: 8,
  maxResponseBytes: 2 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxTools: 512,
  maxEvents: 128,
  maxRateLimitRetries: 1,
  maxRetryDelayMs: 2_000,
}
const MAX_LIMITS: Limits = {
  timeoutMs: 120_000,
  attemptTimeoutMs: 60_000,
  maxRequests: 64,
  maxListPages: 32,
  maxResponseBytes: 16 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxTools: 2048,
  maxEvents: 1024,
  maxRateLimitRetries: 3,
  maxRetryDelayMs: 10_000,
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function invalid(reason: string): SkillsError {
  return fail("MCP_INVALID_RESPONSE", "Notion MCP returned an unsupported or invalid response.", {
    reason,
  })
}

function unsupported(reason: string): SkillsError {
  return fail("MCP_UNSUPPORTED", "This Notion MCP connection does not support this operation.", {
    reason,
  })
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw invalid("invalid_json")
  }
}

function parseLimits(input: NotionMcpBudgets | undefined): Limits {
  const limits = { ...DEFAULT_LIMITS }
  const keys: readonly (keyof Limits)[] = [
    "timeoutMs",
    "attemptTimeoutMs",
    "maxRequests",
    "maxListPages",
    "maxResponseBytes",
    "maxTotalBytes",
    "maxTools",
    "maxEvents",
    "maxRateLimitRetries",
    "maxRetryDelayMs",
  ]
  for (const key of keys) {
    const value = input?.[key] ?? DEFAULT_LIMITS[key]
    const maximum = MAX_LIMITS[key]
    const minimum = key === "maxRateLimitRetries" || key === "maxRetryDelayMs" ? 0 : 1
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
      throw fail("ARGUMENT_INVALID", "The MCP request budgets are outside their supported range.")
    limits[key] = value
  }
  return limits
}

function notionPageId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  try {
    const url = new URL(value)
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !/^(?:www\.)?notion\.so$|^(?:[a-z0-9-]+\.)?notion\.site$|^app\.notion\.com$/iu.test(
        url.hostname,
      )
    )
      return undefined
    if (url.hostname === "app.notion.com" && !/^\/p\/[^/]+\/?$/u.test(url.pathname))
      return undefined
    const match =
      /([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/?$/iu.exec(
        url.pathname,
      )
    return match ? identityId(match[1]) : undefined
  } catch {
    return undefined
  }
}

function endpoint(input: string | undefined): string {
  try {
    const url = new URL(input ?? NOTION_MCP_ENDPOINT)
    const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.href !== NOTION_MCP_ENDPOINT && !(url.protocol === "http:" && loopback))
    )
      throw new Error()
    return url.href
  } catch {
    throw fail(
      "CONFIG_ERROR",
      "Use the hosted Notion MCP endpoint or an explicit loopback HTTP test endpoint.",
    )
  }
}

function identityId(value: unknown): string {
  if (typeof value !== "string") throw invalid("invalid_identity")
  const compact = value.replaceAll("-", "").toLowerCase()
  if (
    !/^[a-f0-9]{32}$/u.test(compact) ||
    !/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/iu.test(value)
  )
    throw invalid("invalid_identity")
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20),
  ].join("-")
}

function parseIdentity(value: unknown): NotionMcpIdentity {
  if (
    !isObject(value) ||
    !isObject(value.workspace) ||
    !isObject(value.user) ||
    typeof value.workspace.name !== "string" ||
    typeof value.user.name !== "string" ||
    (value.user.type !== "person" && value.user.type !== "bot")
  )
    throw invalid("invalid_identity")
  return {
    workspaceId: identityId(value.workspace.id),
    principalId: identityId(value.user.id),
  }
}

function headerValue(value: string): string {
  return /^[\t\x20-\x7e]*$/u.test(value) &&
    value.trim() === value &&
    !(value.startsWith("=?base64?") && value.endsWith("?="))
    ? value
    : "=?base64?" + Buffer.from(value, "utf8").toString("base64") + "?="
}

function collectHeaderParameters(schema: JsonObject): readonly HeaderParameter[] | undefined {
  const headers: HeaderParameter[] = []
  const names = new Set<string>()
  let visited = 0
  const visit = (value: unknown, path: readonly string[] | undefined, depth: number): boolean => {
    if (++visited > 4096 || depth > 32) return false
    if (Array.isArray(value)) return value.every((item) => visit(item, undefined, depth + 1))
    if (!isObject(value)) return true
    if (Object.hasOwn(value, "x-mcp-header")) {
      const name = value["x-mcp-header"]
      const type = value.type
      if (
        !path?.length ||
        typeof name !== "string" ||
        !/^[!#$%&'*+.^_\x60|~0-9A-Za-z-]{1,128}$/u.test(name) ||
        names.has(name.toLowerCase()) ||
        (type !== "string" && type !== "integer" && type !== "boolean")
      )
        return false
      names.add(name.toLowerCase())
      headers.push({ path, name, type })
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "properties" && isObject(child)) {
        for (const [property, propertySchema] of Object.entries(child))
          if (!visit(propertySchema, path ? [...path, property] : undefined, depth + 1))
            return false
      } else if (key !== "x-mcp-header" && !visit(child, undefined, depth + 1)) return false
    }
    return true
  }
  return visit(schema, [], 0) ? headers : undefined
}

/** Validate only the declared parameters we send; unsupported schema constraints fail closed. */
function validateArguments(schema: JsonObject, args: JsonObject): void {
  if (schema.type !== "object" || !isObject(schema.properties ?? {}))
    throw unsupported("tool_schema")
  for (const constraint of ["$ref", "allOf", "anyOf", "oneOf", "not", "if", "dependentRequired"])
    if (Object.hasOwn(schema, constraint)) throw unsupported("tool_schema")
  const properties = schema.properties ?? {}
  if (!isObject(properties)) throw unsupported("tool_schema")
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.some((name) => typeof name !== "string"))
      throw unsupported("tool_schema")
    for (const name of schema.required)
      if (typeof name !== "string" || !Object.hasOwn(args, name))
        throw unsupported("required_tool_parameter")
  }
  for (const [key, value] of Object.entries(args)) {
    const parameter = properties[key]
    if (!Object.hasOwn(properties, key) || !isObject(parameter)) throw unsupported("tool_parameter")
    for (const constraint of ["$ref", "allOf", "anyOf", "oneOf", "not", "if", "pattern", "format"])
      if (Object.hasOwn(parameter, constraint)) throw unsupported("tool_parameter_schema")
    const type = parameter.type
    if (
      !(
        (type === "string" && typeof value === "string") ||
        (type === "number" && typeof value === "number" && Number.isFinite(value)) ||
        (type === "integer" && typeof value === "number" && Number.isSafeInteger(value)) ||
        (type === "boolean" && typeof value === "boolean")
      ) ||
      (Array.isArray(parameter.enum) && !parameter.enum.includes(value)) ||
      (Object.hasOwn(parameter, "const") && parameter.const !== value) ||
      (typeof value === "number" &&
        ((typeof parameter.minimum === "number" && value < parameter.minimum) ||
          (typeof parameter.maximum === "number" && value > parameter.maximum))) ||
      (typeof value === "string" &&
        ((typeof parameter.minLength === "number" &&
          Array.from(value).length < parameter.minLength) ||
          (typeof parameter.maxLength === "number" &&
            Array.from(value).length > parameter.maxLength)))
    )
      throw unsupported("tool_parameter_schema")
  }
}

function toolHeaders(tool: Tool, args: JsonObject): Record<string, string> {
  const headers: Record<string, string> = { "Mcp-Name": headerValue(tool.name) }
  for (const field of tool.headers) {
    let value: unknown = args
    for (const key of field.path)
      value = isObject(value) && Object.hasOwn(value, key) ? value[key] : undefined
    if (value === undefined || value === null) continue
    if (
      !(
        (field.type === "string" && typeof value === "string") ||
        (field.type === "integer" && typeof value === "number" && Number.isSafeInteger(value)) ||
        (field.type === "boolean" && typeof value === "boolean")
      )
    )
      throw unsupported("tool_header_parameter")
    headers["Mcp-Param-" + field.name] = headerValue(String(value))
  }
  return headers
}

function retrySeconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function retryHeader(value: string | null): number | undefined {
  if (value === null) return undefined
  if (/^\d+(?:\.\d+)?$/u.test(value)) return retrySeconds(Number(value))
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, (at - Date.now()) / 1000) : undefined
}

function toolPayload(result: JsonObject): unknown {
  if (Object.hasOwn(result, "structuredContent")) return result.structuredContent
  if (!Array.isArray(result.content)) throw invalid("tool_content")
  let payload: unknown
  let found = false
  for (const block of result.content) {
    if (!isObject(block) || block.type !== "text" || typeof block.text !== "string") continue
    let parsed: unknown
    try {
      parsed = JSON.parse(block.text)
    } catch {
      // Notion can append an explanatory text block after the JSON result.
      continue
    }
    if (found) throw invalid("ambiguous_tool_content")
    payload = parsed
    found = true
  }
  if (!found) throw invalid("tool_json_missing")
  return payload
}

function toolFailure(result: JsonObject): SkillsError {
  let payload: unknown
  try {
    payload = toolPayload(result)
  } catch {
    return fail("MCP_UNAVAILABLE", "The Notion MCP tool failed.", { reason: "tool_error" })
  }
  const error = isObject(payload) && isObject(payload.error) ? payload.error : payload
  const code = isObject(error) ? error.code : undefined
  if (code === "rate_limited")
    return fail("MCP_RATE_LIMITED", "Notion MCP is rate limited.", {
      reason: "tool_rate_limit",
      retry_after_seconds:
        retrySeconds(isObject(error) ? error.retry_after_seconds : undefined) ?? 60,
    })
  if (code === "validation_error") return unsupported("tool_validation")
  if (code === "unauthorized")
    return fail("MCP_AUTH_REQUIRED", "The MCP credential was rejected.", { reason: "tool_auth" })
  if (code === "restricted_resource" || code === "object_not_found")
    return fail("MCP_ACCESS_DENIED", "This MCP connection cannot access the requested content.", {
      reason: "tool_access",
    })
  return fail("MCP_UNAVAILABLE", "The Notion MCP tool failed.", { reason: "tool_error" })
}

class NotionMcpClient {
  readonly limits: Limits
  readonly url: string
  readonly deadline: number
  private requests = 0
  private bytes = 0

  constructor(private readonly options: NotionMcpOptions) {
    this.limits = parseLimits(options.budgets)
    this.url = endpoint(options.serverUrl)
    if (
      typeof options.bearer !== "string" ||
      !options.bearer ||
      options.bearer.length > 16_384 ||
      !/^[\x21-\x7e]+$/u.test(options.bearer)
    )
      throw fail("MCP_AUTH_REQUIRED", "A valid MCP bearer credential is required.", {
        reason: "credential_missing",
      })
    if (options.deadline !== undefined && !Number.isFinite(options.deadline))
      throw fail("ARGUMENT_INVALID", "The MCP deadline must be a finite time.")
    this.deadline = Math.min(options.deadline ?? Infinity, Date.now() + this.limits.timeoutMs)
  }

  private check(): void {
    if (this.options.signal?.aborted)
      throw fail("MCP_CANCELLED", "The Notion MCP operation was cancelled.")
    if (Date.now() >= this.deadline)
      throw fail("MCP_TIMEOUT", "The Notion MCP operation reached its deadline.")
  }

  private async wait(seconds: number): Promise<void> {
    this.check()
    const delay = Math.ceil(seconds * 1000)
    if (delay > this.limits.maxRetryDelayMs || Date.now() + delay >= this.deadline)
      throw fail("MCP_RATE_LIMITED", "Notion MCP is rate limited.", {
        reason: "retry_budget",
        retry_after_seconds: seconds,
      })
    await new Promise<void>((resolve, reject) => {
      const cancel = () => {
        clearTimeout(timer)
        this.options.signal?.removeEventListener("abort", cancel)
        reject(fail("MCP_CANCELLED", "The Notion MCP operation was cancelled."))
      }
      const timer = setTimeout(() => {
        this.options.signal?.removeEventListener("abort", cancel)
        resolve()
      }, delay)
      this.options.signal?.addEventListener("abort", cancel, { once: true })
      if (this.options.signal?.aborted) cancel()
    })
    this.check()
  }

  private envelope(
    value: unknown,
    id: number,
    notification: boolean,
    allowErrorWithoutId = false,
  ): JsonObject | undefined {
    if (!isObject(value) || value.jsonrpc !== "2.0") throw invalid("jsonrpc")
    if (Object.hasOwn(value, "error")) {
      if (
        Object.hasOwn(value, "result") ||
        !isObject(value.error) ||
        !Number.isSafeInteger(value.error.code)
      )
        throw invalid("jsonrpc_error")
      if (value.id !== id && !(allowErrorWithoutId && value.id == null))
        throw invalid("response_id")
      const code = value.error.code
      if (code === -32022) throw unsupported("protocol_version")
      if (code === -32020) throw unsupported("header_mismatch")
      if (code === -32601) throw unsupported("rpc_method")
      if (code === -32602) throw unsupported("rpc_parameters")
      throw fail("MCP_UNAVAILABLE", "The Notion MCP request failed.", { reason: "rpc_error" })
    }
    if (!Object.hasOwn(value, "id") && notification) {
      if (
        typeof value.method === "string" &&
        value.method.startsWith("notifications/") &&
        !Object.hasOwn(value, "result") &&
        !Object.hasOwn(value, "error")
      )
        return undefined
      throw invalid("notification")
    }
    if (value.id !== id) throw invalid("response_id")
    if (!isObject(value.result)) throw invalid("rpc_result")
    if (value.result.resultType === "input_required") throw unsupported("input_required")
    if (value.result.resultType !== "complete") throw unsupported("result_type")
    return value.result
  }

  private async read(response: Response, id: number): Promise<JsonObject> {
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()
    if (contentType !== "application/json" && contentType !== "text/event-stream")
      throw invalid("content_type")
    if (!response.body) throw invalid("empty_body")
    const reader = response.body.getReader()
    const decoder = new TextDecoder("utf-8", { fatal: true })
    let responseBytes = 0
    let text = ""
    let eventData: string[] = []
    let events = 0
    let afterCr = false
    const consumeEvent = (): JsonObject | undefined => {
      if (!eventData.length) return undefined
      if (++events > this.limits.maxEvents)
        throw fail("MCP_BUDGET_EXCEEDED", "The MCP event limit was reached.", {
          reason: "event_limit",
        })
      const data = eventData.join("\n")
      eventData = []
      return this.envelope(parseJson(data), id, true, !response.ok)
    }
    const consumeLine = (line: string): JsonObject | undefined => {
      if (line === "") return consumeEvent()
      if (line.startsWith(":")) return undefined
      const colon = line.indexOf(":")
      const field = colon === -1 ? line : line.slice(0, colon)
      let data = colon === -1 ? "" : line.slice(colon + 1)
      if (data.startsWith(" ")) data = data.slice(1)
      if (field === "data") eventData.push(data)
      return undefined
    }
    try {
      while (true) {
        this.check()
        const next = await reader.read()
        if (next.done) break
        responseBytes += next.value.byteLength
        this.bytes += next.value.byteLength
        if (responseBytes > this.limits.maxResponseBytes || this.bytes > this.limits.maxTotalBytes)
          throw fail("MCP_BUDGET_EXCEEDED", "The MCP response size limit was reached.", {
            reason: "response_limit",
          })
        let chunk: string
        try {
          chunk = decoder.decode(next.value, { stream: true })
        } catch {
          throw invalid("utf8")
        }
        if (contentType === "application/json") {
          text += chunk
          continue
        }
        if (!chunk) continue
        if (afterCr && chunk.startsWith("\n")) chunk = chunk.slice(1)
        afterCr = false
        text += chunk
        let boundary = text.search(/[\r\n]/u)
        while (boundary >= 0) {
          const line = text.slice(0, boundary)
          const cr = text[boundary] === "\r"
          let end = boundary + 1
          if (cr && text[end] === "\n") end++
          afterCr = cr && end === text.length
          text = text.slice(end)
          const result = consumeLine(line)
          if (result) return result
          boundary = text.search(/[\r\n]/u)
        }
      }
      try {
        text += decoder.decode()
      } catch {
        throw invalid("utf8")
      }
      if (contentType === "application/json") {
        const result = this.envelope(parseJson(text), id, false, !response.ok)
        if (result) return result
      }
      // An SSE event needs its terminating empty line. EOF is not a completed response.
      throw invalid("incomplete_response")
    } finally {
      void reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }

  private async attempt(
    method: "tools/list" | "tools/call",
    params: JsonObject,
    headers: Record<string, string>,
  ): Promise<JsonObject> {
    this.check()
    if (this.requests >= this.limits.maxRequests)
      throw fail("MCP_BUDGET_EXCEEDED", "The MCP request limit was reached.", {
        reason: "request_limit",
      })
    const id = ++this.requests
    const controller = new AbortController()
    const cancel = () => controller.abort()
    const timer = setTimeout(
      cancel,
      Math.min(this.limits.attemptTimeoutMs, this.deadline - Date.now()),
    )
    this.options.signal?.addEventListener("abort", cancel, { once: true })
    let response: Response | undefined
    try {
      this.check()
      response = await fetch(this.url, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Authorization: "Bearer " + this.options.bearer,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": NOTION_MCP_PROTOCOL_VERSION,
          "Mcp-Method": method,
          ...headers,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": NOTION_MCP_PROTOCOL_VERSION,
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": { name: "notion-skills-cli", version: "1" },
            },
          },
        }),
      })
      if (response.status === 401)
        throw fail("MCP_AUTH_REQUIRED", "The MCP credential was rejected.", { http_status: 401 })
      if (response.status === 403)
        throw fail(
          "MCP_ACCESS_DENIED",
          "This MCP connection cannot access the requested content.",
          {
            http_status: 403,
          },
        )
      if (response.status === 429)
        throw fail("MCP_RATE_LIMITED", "Notion MCP is rate limited.", {
          http_status: 429,
          reason: "http_rate_limit",
          retry_after_seconds: retryHeader(response.headers.get("retry-after")) ?? 60,
        })
      if (response.status >= 300 && response.status < 400) throw unsupported("redirect")
      if (response.status === 405) throw unsupported("http_method")
      if (response.status >= 500)
        throw fail("MCP_UNAVAILABLE", "The Notion MCP server is unavailable.", {
          http_status: response.status,
          reason: "http_error",
        })
      const result = await this.read(response, id)
      if (!response.ok)
        throw fail("MCP_UNAVAILABLE", "The Notion MCP request failed.", {
          http_status: response.status,
          reason: "http_error",
        })
      this.check()
      if (result.isError === true) throw toolFailure(result)
      if (result.isError !== undefined && result.isError !== false) throw invalid("tool_error_flag")
      return result
    } catch (error) {
      this.check()
      if (controller.signal.aborted)
        throw fail("MCP_TIMEOUT", "The Notion MCP HTTP attempt timed out.")
      if (error instanceof SkillsError) throw error
      throw fail("MCP_UNAVAILABLE", "The Notion MCP connection failed.", { reason: "network" })
    } finally {
      clearTimeout(timer)
      this.options.signal?.removeEventListener("abort", cancel)
      controller.abort()
      if (response?.body && !response.body.locked)
        void response.body.cancel().catch(() => undefined)
    }
  }

  private async request(
    method: "tools/list" | "tools/call",
    params: JsonObject,
    headers: Record<string, string> = {},
  ): Promise<JsonObject> {
    for (let retry = 0; ; retry++) {
      try {
        return await this.attempt(method, params, headers)
      } catch (error) {
        if (!(error instanceof SkillsError)) throw error
        const details = isObject(error.details) ? error.details : {}
        const delay = retrySeconds(details.retry_after_seconds)
        if (
          error.code !== "MCP_RATE_LIMITED" ||
          retry >= this.limits.maxRateLimitRetries ||
          delay === undefined
        )
          throw fail(error.code, error.message, {
            ...details,
            request_count: this.requests,
            response_bytes: this.bytes,
          })
        await this.wait(delay)
      }
    }
  }

  private async listTools(): Promise<ReadonlyMap<string, Tool>> {
    const tools = new Map<string, Tool>()
    const seen = new Set<string>()
    const cursorSeen = new Set<string>()
    let cursor: string | undefined
    let count = 0
    for (let page = 0; page < this.limits.maxListPages; page++) {
      const result = await this.request("tools/list", cursor === undefined ? {} : { cursor })
      if (!Array.isArray(result.tools)) throw invalid("tools_list")
      count += result.tools.length
      if (count > this.limits.maxTools)
        throw fail("MCP_BUDGET_EXCEEDED", "The MCP tool count limit was reached.", {
          reason: "tool_limit",
        })
      for (const value of result.tools) {
        if (
          !isObject(value) ||
          typeof value.name !== "string" ||
          !value.name ||
          value.name.length > 128
        )
          throw invalid("tool_definition")
        if (seen.has(value.name)) throw invalid("duplicate_tool")
        seen.add(value.name)
        if (
          !["notion-search", "search", "notion-get-self", "notion-fetch", "fetch"].includes(
            value.name,
          )
        )
          continue
        if (!isObject(value.inputSchema)) continue
        const headers = collectHeaderParameters(value.inputSchema)
        if (headers)
          tools.set(value.name, { name: value.name, inputSchema: value.inputSchema, headers })
      }
      if (result.nextCursor === undefined || result.nextCursor === null) return tools
      if (typeof result.nextCursor !== "string" || result.nextCursor.length > 16_384)
        throw invalid("tools_cursor")
      if (cursorSeen.has(result.nextCursor)) throw invalid("repeated_cursor")
      cursorSeen.add(result.nextCursor)
      cursor = result.nextCursor
    }
    throw fail("MCP_BUDGET_EXCEEDED", "The MCP tool-list page limit was reached.", {
      reason: "list_page_limit",
    })
  }

  private async call(tool: Tool, args: JsonObject): Promise<unknown> {
    validateArguments(tool.inputSchema, args)
    const result = await this.request(
      "tools/call",
      { name: tool.name, arguments: args },
      toolHeaders(tool, args),
    )
    return toolPayload(result)
  }

  async identity(): Promise<NotionMcpIdentity> {
    const tools = await this.listTools()
    const self = tools.get("notion-get-self")
    if (self) return parseIdentity(await this.call(self, {}))
    const fetchTool = tools.get("notion-fetch") ?? tools.get("fetch")
    if (!fetchTool) throw unsupported("identity_tool")
    const value = await this.call(fetchTool, { id: "self" })
    return parseIdentity(isObject(value) ? value.self : undefined)
  }

  async verifySource(pageId: string): Promise<void> {
    const expected = identityId(pageId)
    const tools = await this.listTools()
    const tool = tools.get("notion-fetch") ?? tools.get("fetch")
    if (!tool) throw unsupported("source_verification_tool")
    const value = await this.call(tool, { id: expected })
    if (
      !isObject(value) ||
      !isObject(value.metadata) ||
      typeof value.metadata.type !== "string" ||
      !["page", "database", "data_source"].includes(value.metadata.type) ||
      notionPageId(value.url) !== expected
    )
      throw unsupported("source_verification_schema")
    if (value.id !== undefined && identityId(value.id) !== expected)
      throw invalid("source_identity_mismatch")
  }

  async search(
    options: Pick<NotionMcpSearchOptions, "query" | "pageSize" | "pageUrl" | "dataSourceUrl">,
  ): Promise<NotionMcpSearchResult> {
    if (!options.query.trim() || options.query.length > 4096)
      throw fail(
        "ARGUMENT_INVALID",
        "Content search requires a nonempty query of at most 4096 characters.",
      )
    const pageSize = options.pageSize ?? 50
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50)
      throw fail("ARGUMENT_INVALID", "MCP search page size must be between 1 and 50.")
    const tools = await this.listTools()
    const tool = tools.get("notion-search") ?? tools.get("search")
    if (!tool) throw unsupported("search_tool")
    const args: JsonObject = { query: options.query }
    const properties = isObject(tool.inputSchema.properties) ? tool.inputSchema.properties : {}
    if (Object.hasOwn(properties, "query_type")) args.query_type = "internal"
    if (Object.hasOwn(properties, "page_size")) args.page_size = pageSize
    if (Object.hasOwn(properties, "max_highlight_length")) args.max_highlight_length = 350
    if (options.pageUrl !== undefined) args.page_url = options.pageUrl
    if (options.dataSourceUrl !== undefined) args.data_source_url = options.dataSourceUrl
    const value = await this.call(tool, args)
    if (!isObject(value) || value.type !== "workspace_search")
      throw unsupported("search_result_type")
    return decodeWorkspaceSearch(value, pageSize)
  }
}

/** Standard workspace_search shape observed with the hosted July protocol.
 * Ancestor paths, verification data and other remote metadata never leave this boundary. */
function decodeWorkspaceSearch(value: JsonObject, pageSize: number): NotionMcpSearchResult {
  if (!Array.isArray(value.results)) throw unsupported("search_result_schema")
  if (value.results.length > pageSize)
    throw fail("MCP_BUDGET_EXCEEDED", "The MCP search result limit was reached.", {
      reason: "search_result_limit",
    })
  if (value.notices !== undefined && !Array.isArray(value.notices))
    throw unsupported("search_notice_schema")
  const matches: NotionMcpSearchMatch[] = []
  for (const item of value.results) {
    if (
      !isObject(item) ||
      item.type !== "page" ||
      typeof item.title !== "string" ||
      (item.highlight !== undefined && typeof item.highlight !== "string")
    )
      throw unsupported("search_item_schema")
    const pageId = identityId(item.id)
    if (notionPageId(item.url) !== pageId) throw invalid("search_identity_mismatch")
    matches.push({
      pageId,
      title: item.title.slice(0, 512),
      ...(typeof item.highlight === "string" ? { snippet: item.highlight.slice(0, 2000) } : {}),
      url: `https://www.notion.so/${pageId.replaceAll("-", "")}`,
    })
  }
  return {
    matches,
    notices:
      Array.isArray(value.notices) && value.notices.length > 0
        ? [{ kind: "remote_notice", count: value.notices.length }]
        : [],
    exhaustive: false,
  }
}

export async function getNotionMcpIdentity(options: NotionMcpOptions): Promise<NotionMcpIdentity> {
  return new NotionMcpClient(options).identity()
}

export async function searchNotionMcp(
  options: NotionMcpSearchOptions,
): Promise<NotionMcpSearchResult> {
  return new NotionMcpClient(options).search(options)
}

export async function verifyNotionMcpSource(
  options: NotionMcpOptions & { readonly pageId: string },
): Promise<void> {
  return new NotionMcpClient(options).verifySource(options.pageId)
}
