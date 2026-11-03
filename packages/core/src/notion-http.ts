import { Config, Effect, FileSystem, Path, Redacted, Schema, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { fail, property, SkillsError } from "./model.ts"
import type { NotionCredential } from "./notion-credential.ts"

// https://developers.notion.com/reference/versioning, verified 2026-11-03.
export const NOTION_API_VERSION = "2026-03-11"
export const NOTION_RESPONSE_LIMIT = 16 * 1024 * 1024
export const NOTION_SINGLE_UPLOAD_LIMIT = 20 * 1024 * 1024

export const notionApiOrigin = Config.String("NOTION_API_BASE_URL").pipe(
  Config.withDefault("https://api.notion.com"),
  Effect.flatMap((input) =>
    Effect.try({
      try: () => {
        const url = new URL(input)
        const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        if (
          (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          url.pathname !== "/"
        )
          throw new Error("Invalid API origin")
        return url.origin
      },
      catch: () =>
        fail(
          "CONFIG_ERROR",
          "NOTION_API_BASE_URL must be an HTTPS origin or a loopback HTTP origin.",
        ),
    }),
  ),
  Effect.mapError((error) =>
    error instanceof SkillsError
      ? error
      : fail("CONFIG_ERROR", "The Notion API origin configuration is invalid."),
  ),
)

export type NotionHttpResponse = {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly value: unknown
  readonly bytes: number
}

export const prepareNotionRequest = Effect.fnUntraced(function* (input: {
  readonly origin: string
  readonly path: string
  readonly method: "GET" | "POST" | "PATCH"
  readonly credential: NotionCredential
  readonly body?: unknown
  readonly file?: string
}) {
  const url = yield* Effect.try({
    try: () => {
      if (!/^v1\//u.test(input.path) || /(?:^|\/)\.\.(?:\/|\?|$)/u.test(input.path))
        throw new Error("Invalid path")
      const url = new URL(input.path, `${input.origin}/`)
      if (url.origin !== input.origin || url.hash || !url.pathname.startsWith("/v1/"))
        throw new Error("Invalid path")
      return url.href
    },
    catch: () =>
      fail("ARGUMENT_INVALID", "Use a relative Notion v1 API path.", { phase: "input_rejected" }),
  })
  let request = HttpClientRequest.make(input.method)(url).pipe(
    HttpClientRequest.bearerToken(input.credential.token),
    HttpClientRequest.setHeader("Notion-Version", NOTION_API_VERSION),
    HttpClientRequest.acceptJson,
  )
  let requestBytes = 0
  if (input.file !== undefined) {
    if (input.body !== undefined)
      return yield* Effect.fail(
        fail("ARGUMENT_INVALID", "A file upload cannot also supply a JSON body.", {
          phase: "input_rejected",
        }),
      )
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const unreadable = () =>
      fail("ARGUMENT_INVALID", "The upload file could not be read.", {
        phase: "input_rejected",
      })
    const tooLarge = () =>
      fail("FILE_TOO_LARGE", "Direct upload supports files up to 20 MiB.", {
        phase: "input_rejected",
      })
    const info = yield* fs.stat(input.file).pipe(Effect.mapError(unreadable))
    if (info.type !== "File") return yield* Effect.fail(unreadable())
    if (info.size > NOTION_SINGLE_UPLOAD_LIMIT) return yield* Effect.fail(tooLarge())
    let fileBytes = 0
    const chunks = yield* fs
      .stream(input.file, { bytesToRead: NOTION_SINGLE_UPLOAD_LIMIT + 1 })
      .pipe(
        Stream.mapEffect((chunk) => {
          fileBytes += chunk.byteLength
          return fileBytes > NOTION_SINGLE_UPLOAD_LIMIT
            ? Effect.fail(tooLarge())
            : Effect.succeed(Uint8Array.from(chunk).buffer)
        }),
        Stream.runCollect,
        Effect.mapError((error) => (error instanceof SkillsError ? error : unreadable())),
      )
    const form = new FormData()
    form.append("file", new Blob(chunks), path.basename(input.file))
    // Use the platform multipart encoder once. Its boundary, filename escaping,
    // MIME headers and bytes are immutable across safe rejected-write retries.
    const encoded = new Response(form)
    // Bun materializes FormData headers lazily; read the boundary before consuming.
    const contentType = encoded.headers.get("content-type")
    if (contentType === null) return yield* Effect.fail(unreadable())
    const payload = yield* Effect.tryPromise({
      try: async () => new Uint8Array(await encoded.arrayBuffer()),
      catch: () => unreadable(),
    })
    requestBytes = payload.byteLength
    request = HttpClientRequest.bodyUint8Array(request, payload, contentType)
  } else if (input.body !== undefined) {
    request = yield* HttpClientRequest.bodyJson(request, input.body).pipe(
      Effect.mapError(() =>
        fail("ARGUMENT_INVALID", "The Notion request body is not serializable JSON.", {
          phase: "input_rejected",
        }),
      ),
    )
    if (request.body._tag === "Uint8Array") requestBytes = request.body.body.byteLength
  }
  return { request, requestBytes }
})

/** One HTTP attempt only. Scheduling and retry policy remain in Notion. */
export const sendNotionRequest = Effect.fnUntraced(function* (input: {
  readonly client: HttpClient.HttpClient
  readonly request: HttpClientRequest.HttpClientRequest
  readonly credential: NotionCredential
  readonly observe: (metadata: ReturnType<typeof notionResponseDetails>, bytes: number) => void
}) {
  const response = yield* HttpClient.withScope(input.client)
    .execute(input.request)
    .pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.mapError(() =>
        fail("NOTION_UNAVAILABLE", "The Notion HTTP connection failed.", { reason: "network" }),
      ),
    )
  let bytes = 0
  const metadata = notionResponseDetails(
    { status: response.status, headers: response.headers, value: undefined, bytes },
    input.credential,
  )
  input.observe(metadata, bytes)
  const text = yield* response.stream.pipe(
    Stream.mapEffect((chunk) => {
      bytes += chunk.byteLength
      input.observe(metadata, bytes)
      return bytes > NOTION_RESPONSE_LIMIT
        ? Effect.fail(
            fail("INVALID_RESPONSE", "The Notion response exceeded its size limit.", {
              reason: "response_limit",
              http_status: response.status,
            }),
          )
        : Effect.succeed(chunk)
    }),
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (value, chunk) => value + chunk,
    ),
    Effect.mapError((error) =>
      error instanceof SkillsError
        ? fail(error.code, error.message, {
            ...property(error.details),
            ...metadata,
            response_bytes: bytes,
          })
        : fail("NOTION_UNAVAILABLE", "The Notion response stream failed.", {
            reason: "network",
            ...metadata,
            response_bytes: bytes,
          }),
    ),
  )
  const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
    text,
  ).pipe(
    Effect.mapError(() =>
      fail("INVALID_RESPONSE", "The Notion API returned invalid JSON.", {
        ...metadata,
        reason: "invalid_json",
        response_bytes: bytes,
      }),
    ),
  )
  input.observe(
    notionResponseDetails(
      { status: response.status, headers: response.headers, value: decoded, bytes },
      input.credential,
    ),
    bytes,
  )
  return {
    status: response.status,
    headers: response.headers,
    value: decoded,
    bytes,
  } satisfies NotionHttpResponse
})

const safeWord = (value: unknown, maximum = 128) =>
  typeof value === "string" && value.length <= maximum && /^[a-z][a-z0-9_]*$/u.test(value)
    ? value
    : undefined
const safeId = (value: unknown) =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/u.test(value)
    ? value
    : undefined
const uuid = (value: unknown) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value)
    ? value.toLowerCase()
    : undefined
const waitSeconds = (value: unknown) => {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+(?:\.\d+)?$/u.test(value)
        ? Number(value)
        : NaN
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

export function notionResponseDetails(response: NotionHttpResponse, credential: NotionCredential) {
  const secret = Redacted.value(credential.token).toLowerCase()
  const safe = (value: string | undefined) =>
    value !== undefined && !value.toLowerCase().includes(secret)
  const value = property(response.value)
  const additional = property(value.additional_data)
  const headerDelay = waitSeconds(response.headers["retry-after"])
  const bodyDelay = waitSeconds(additional.retry_after)
  const requestId = safeId(
    response.headers["x-request-id"] ?? response.headers["request-id"] ?? value.request_id,
  )
  const rateLimitReason = safeWord(additional.rate_limit_reason)
  const resourceId = uuid(additional.committed_resource_id)
  const childIds = Array.isArray(additional.committed_child_ids)
    ? additional.committed_child_ids.map(uuid)
    : undefined
  const guidance = Array.isArray(additional.retry_guidance)
    ? additional.retry_guidance.filter(
        (item) =>
          item === "Read the object again to confirm the saved change." ||
          item === "Do not repeat the write.",
      )
    : undefined
  const safeAdditional = {
    ...(safe(resourceId) ? { committed_resource_id: resourceId } : {}),
    ...(childIds && childIds.length <= 100 && childIds.every(safe)
      ? { committed_child_ids: childIds }
      : {}),
    ...(guidance?.length ? { retry_guidance: guidance } : {}),
  }
  const limited = response.status === 429 || response.status === 529
  return {
    http_status: response.status,
    ...(safe(requestId) ? { request_id: requestId } : {}),
    ...(limited || headerDelay !== undefined || bodyDelay !== undefined
      ? {
          retry_after_seconds: Math.max(
            headerDelay ?? 0,
            bodyDelay ?? 0,
            headerDelay === undefined && bodyDelay === undefined ? 60 : 0,
          ),
          retry_after_source:
            headerDelay !== undefined && (bodyDelay === undefined || headerDelay >= bodyDelay)
              ? "header"
              : bodyDelay !== undefined
                ? "api"
                : "fallback",
          ...(headerDelay === undefined ? {} : { retry_after_header_seconds: headerDelay }),
          ...(bodyDelay === undefined ? {} : { retry_after_body_seconds: bodyDelay }),
          ...(safe(rateLimitReason) ? { rate_limit_reason: rateLimitReason } : {}),
        }
      : {}),
    ...(Object.keys(safeAdditional).length ? { additional_data: safeAdditional } : {}),
  }
}

export function verifiedWorkspaceId(value: unknown): string | null {
  return uuid(property(property(value).bot).workspace_id) ?? null
}
