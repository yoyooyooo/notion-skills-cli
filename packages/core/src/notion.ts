import { Clock, Config, Context, Crypto, Effect, Layer, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { ApiErrorSchema, decode, fail, property, SkillsError } from "./model.ts"
import { configuredToken, sha256, Store } from "./store.ts"
import {
  NOTION_ADMISSION_BUDGET_MS,
  NotionRequestScheduler,
  NotionRequestSchedulerLive,
} from "./notion-request-scheduler.ts"
import { requestTimeoutMs } from "./request-timeout.ts"

export class Notion extends Context.Service<
  Notion,
  {
    readonly request: (
      path: string,
      body?: unknown,
      options?: { readonly method?: "GET" | "POST" | "PATCH"; readonly file?: string },
    ) => Effect.Effect<unknown, SkillsError>
    readonly version: Effect.Effect<string, SkillsError>
    readonly credentialIdentity: Effect.Effect<string, SkillsError>
  }
>()("ntn-skills/Notion") {}
function transportReason(stderr: string) {
  if (stderr === "error: Failed to execute public API request\n") return "unknown_transport"
  if (/timed? ?out|timeout/i.test(stderr)) return "timeout"
  if (/dns|resolve|name.*resolution|ENOTFOUND/i.test(stderr)) return "dns"
  if (/certificate|TLS|SSL/i.test(stderr)) return "tls"
  if (/connect|network|transport|ECONNRESET|ECONNREFUSED/i.test(stderr)) return "network"
  return "invalid_response"
}

const rejectionStatus: Readonly<Record<string, number>> = {
  invalid_json: 400,
  invalid_request_url: 400,
  invalid_request: 400,
  validation_error: 400,
  unauthorized: 401,
  restricted_resource: 403,
  object_not_found: 404,
  rate_limited: 429,
}
const apiCodes: Readonly<Record<string, string>> = {
  unauthorized: "AUTH_REQUIRED",
  restricted_resource: "ACCESS_DENIED",
  object_not_found: "NOT_FOUND",
  directory_not_found: "SKILL_NOT_FOUND",
  rate_limited: "RATE_LIMITED",
}
const knownApiCodes: Readonly<Record<string, true>> = {
  invalid_json: true,
  invalid_request_url: true,
  invalid_request: true,
  validation_error: true,
  unauthorized: true,
  restricted_resource: true,
  object_not_found: true,
  rate_limited: true,
  directory_not_found: true,
  conflict_error: true,
  internal_server_error: true,
  service_unavailable: true,
  database_connection_unavailable: true,
  gateway_timeout: true,
}

// Official ntn emits API errors on stderr, with no stdout JSON. Never retain its message.
function officialError(stderr: string, exit: number) {
  if (exit === 0) return undefined
  const match =
    /^error: Public API request failed \(([1-5]\d{2}) [A-Za-z ]+ ([a-z_]+)\):[^\r\n]*\r?\n?$/.exec(
      stderr,
    )
  if (match && Object.hasOwn(knownApiCodes, match[2]!))
    return { status: Number(match[1]), code: match[2]! }
  if (
    exit === 4 &&
    /^error: Public API request failed:[^\r\n]*\n  hint: Set NOTION_API_TOKEN, or run `ntn login` to reuse a saved workspace token\.\s*$/.test(
      stderr,
    )
  )
    return { status: 401, code: "unauthorized" }
  return undefined
}

function isRateLimit(code: unknown, status: unknown) {
  return status === 429 || status === 529 || (status === undefined && code === "rate_limited")
}

function rateLimitDetails(code: string, status?: number, value?: unknown) {
  if (!isRateLimit(code, status)) return {}
  const reported = property(property(value).additional_data).retry_after
  const seconds =
    typeof reported === "number"
      ? reported
      : typeof reported === "string" && /^\d+(?:\.\d+)?$/.test(reported)
        ? Number(reported)
        : undefined
  const valid = seconds !== undefined && Number.isFinite(seconds) && seconds >= 0
  // ntn's current stderr protocol discards Retry-After and response metadata.
  // Never scrape its message; use the full window when no structured delay survives.
  return {
    retry_after_seconds: valid ? seconds : 60,
    retry_after_source: valid ? "api" : "fallback",
  }
}

function apiFailure(
  path: string,
  code: string,
  exit: number,
  mutating: boolean,
  diagnostics: Readonly<Record<string, unknown>>,
  status?: number,
) {
  const safeCode = Object.hasOwn(knownApiCodes, code) ? code : "unrecognized"
  const rejected =
    rejectionStatus[safeCode] !== undefined &&
    (status === undefined || rejectionStatus[safeCode] === status)
  return fail(
    mutating && !rejected
      ? "WRITE_OUTCOME_UNKNOWN"
      : (apiCodes[safeCode] ?? "NOTION_REQUEST_FAILED"),
    "The Notion API request failed.",
    {
      path,
      notion_code: safeCode,
      exit_code: exit,
      ...(status === undefined ? {} : { http_status: status }),
      ...diagnostics,
      phase: rejected ? "definitive_rejection" : "outcome_unknown",
    },
  )
}

export const NotionTransport = Layer.effect(
  Notion,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const store = yield* Store
    const crypto = yield* Crypto.Crypto
    const scheduler = yield* NotionRequestScheduler
    const credential = yield* Effect.cached(
      configuredToken.pipe(Effect.provideService(Store, store)),
    )
    const credentialIdentity = yield* Effect.cached(
      credential.pipe(
        Effect.flatMap((token) => sha256(token ?? "ntn-keychain")),
        Effect.provideService(Crypto.Crypto, crypto),
      ),
    )
    const executable = yield* Config.String("NTN_SKILLS_NTN_BIN").pipe(
      Config.withDefault("ntn"),
      Effect.mapError(() => fail("CONFIG_ERROR", "The ntn executable configuration is invalid.")),
    )
    const timeoutMs = yield* requestTimeoutMs
    // Bound both pipes before decoding; raw diagnostics never leave this scope.
    const capture = <E>(stream: Stream.Stream<Uint8Array, E>, limit: number) =>
      Effect.suspend(() => {
        let bytes = 0
        return stream.pipe(
          Stream.mapEffect((chunk) => {
            bytes += chunk.byteLength
            return bytes > limit
              ? Effect.fail(
                  fail("NTN_UNAVAILABLE", "ntn output exceeded its capture limit.", {
                    reason: "output_limit",
                  }),
                )
              : Effect.succeed(chunk)
          }),
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (text, chunk) => text + chunk,
          ),
        )
      })
    const run = (args: readonly string[], body?: Uint8Array, token?: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const command = ChildProcess.make(executable, args, {
            stdin: body === undefined ? "ignore" : Stream.make(body),
            stdout: "pipe",
            stderr: "pipe",
            detached: false,
            env: { NOTION_API_TOKEN: token },
            extendEnv: true,
          })
          const child = yield* spawner.spawn(command)
          const [stdout, stderr, exit] = yield* Effect.all(
            [
              capture(child.stdout, 16 * 1024 * 1024),
              capture(child.stderr, 64 * 1024),
              child.exitCode,
            ],
            { concurrency: "unbounded" },
          )
          return { stdout, stderr, exit }
        }),
      ).pipe(
        Effect.timeout(timeoutMs),
        Effect.mapError((error) =>
          error instanceof SkillsError
            ? error
            : fail(
                "NTN_UNAVAILABLE",
                "ntn could not complete the request. Check installation, network and authentication with ntn doctor.",
                { reason: property(error)._tag === "TimeoutError" ? "timeout" : "process" },
              ),
        ),
      )
    return {
      credentialIdentity,
      version: run(["--version"]).pipe(
        Effect.flatMap((r) =>
          r.exit === 0
            ? Effect.succeed(r.stdout.trim())
            : Effect.fail(fail("NTN_UNAVAILABLE", "ntn --version failed.")),
        ),
      ),
      request: (path, body, options) =>
        Effect.gen(function* () {
          const token = yield* credential
          const identity = yield* credentialIdentity
          const deadline =
            (yield* Clock.monotonicTimeNanos) + BigInt(NOTION_ADMISSION_BUDGET_MS) * 1_000_000n
          const args = ["api", path, "--notion-version", "2026-03-11"]
          const method = options?.method ?? (body === undefined ? "GET" : "POST")
          const mutating =
            method !== "GET" &&
            path !== "v1/search" &&
            !path.endsWith("/query") &&
            !/^v1\/views\/[0-9a-f-]+\/queries$/.test(path)
          args.push("-X", method)
          const payload =
            body === undefined ? undefined : new TextEncoder().encode(JSON.stringify(body))
          if (payload) args.push("--data", "@-")
          if (options?.file) args.push("--file", options.file)
          const once = Effect.gen(function* () {
            // Admission is pre-send and does not consume this attempt's network timeout.
            yield* scheduler.acquire(identity, deadline)
            const r = yield* run(args, payload, token).pipe(
              Effect.mapError((error) =>
                mutating
                  ? fail(
                      "WRITE_OUTCOME_UNKNOWN",
                      "The write may have completed; read the target before retrying.",
                      { path, cause_code: error.code, cause_details: error.details },
                    )
                  : error,
              ),
            )
            const diagnostics =
              r.exit === 0
                ? {}
                : {
                    stderr_bytes: new TextEncoder().encode(r.stderr).byteLength,
                    stderr_sha256: yield* sha256(r.stderr).pipe(
                      Effect.provideService(Crypto.Crypto, crypto),
                    ),
                  }
            const reported = officialError(r.stderr, r.exit)
            if (reported)
              return yield* Effect.fail(
                apiFailure(
                  path,
                  reported.code,
                  r.exit,
                  mutating,
                  { ...diagnostics, ...rateLimitDetails(reported.code, reported.status) },
                  reported.status,
                ),
              )
            if (
              r.exit === 1 &&
              (/^error: Invalid JSON from --data @-\s*$/.test(r.stderr) ||
                /^error: Failed to read request JSON from [^\r\n]+\s*$/.test(r.stderr))
            )
              return yield* Effect.fail(
                fail(
                  "ARGUMENT_INVALID",
                  "ntn rejected the local request input before sending it.",
                  {
                    path,
                    exit_code: r.exit,
                    ...diagnostics,
                    phase: "input_rejected",
                  },
                ),
              )
            const decoded = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(Schema.Unknown),
            )(r.stdout).pipe(
              Effect.mapError(() =>
                fail(
                  mutating
                    ? "WRITE_OUTCOME_UNKNOWN"
                    : r.exit
                      ? "NOTION_REQUEST_FAILED"
                      : "INVALID_RESPONSE",
                  "ntn returned no valid API JSON. Inspect reason and exit_code; check network and authentication with ntn doctor.",
                  { path, exit_code: r.exit, reason: transportReason(r.stderr), ...diagnostics },
                ),
              ),
              Effect.result,
            )
            if (decoded._tag === "Failure") {
              return yield* Effect.fail(decoded.failure)
            }
            const value = decoded.success
            if (
              value &&
              typeof value === "object" &&
              "object" in value &&
              value.object === "error"
            ) {
              const error = yield* Effect.try({
                try: () => decode(ApiErrorSchema, value),
                catch: () =>
                  fail(
                    mutating ? "WRITE_OUTCOME_UNKNOWN" : "INVALID_RESPONSE",
                    "Invalid Notion error response.",
                  ),
              })
              const rawStatus = property(value).status
              const status =
                typeof rawStatus === "number" &&
                Number.isInteger(rawStatus) &&
                rawStatus >= 100 &&
                rawStatus <= 599
                  ? rawStatus
                  : undefined
              return yield* Effect.fail(
                apiFailure(
                  path,
                  error.code,
                  r.exit,
                  mutating,
                  { ...diagnostics, ...rateLimitDetails(error.code, status, value) },
                  status,
                ),
              )
            }
            if (r.exit !== 0)
              return yield* Effect.fail(
                fail(
                  mutating ? "WRITE_OUTCOME_UNKNOWN" : "NOTION_REQUEST_FAILED",
                  "ntn failed to complete the API request.",
                  {
                    path,
                    exit_code: r.exit,
                    reason: transportReason(r.stderr),
                    ...diagnostics,
                  },
                ),
              )
            return value
          })
          for (let attempt = 0; ; attempt++) {
            const result = yield* once.pipe(Effect.result)
            if (result._tag === "Success") return result.success
            const error = result.failure
            const details = property(error.details)
            const limited = isRateLimit(details.notion_code, details.http_status)
            if (limited) {
              const cooldown = yield* scheduler
                .cooldown(identity, Number(details.retry_after_seconds) * 1_000)
                .pipe(Effect.result)
              if (cooldown._tag === "Failure")
                return yield* Effect.fail(
                  fail(error.code, error.message, {
                    ...details,
                    scheduler_code: cooldown.failure.code,
                  }),
                )
            }
            const retryable =
              limited ||
              (error.code === "NTN_UNAVAILABLE" && details.reason === "timeout") ||
              (["dns", "network", "timeout", "unknown_transport"].includes(
                String(details.reason),
              ) &&
                details.exit_code !== undefined) ||
              [
                "internal_server_error",
                "service_unavailable",
                "database_connection_unavailable",
                "gateway_timeout",
              ].includes(String(details.notion_code))
            // Unknown writes, including 529/500/503 and transport failures, are never replayed.
            // Even a definitive 429 write is returned to the publication checkpoint for recovery.
            if (mutating || !retryable || attempt >= 3) return yield* Effect.fail(error)
            if (!limited) yield* Effect.sleep(1_000 * 2 ** attempt)
          }
        }),
    }
  }),
)

export const NotionLive = NotionTransport.pipe(Layer.provide(NotionRequestSchedulerLive))
