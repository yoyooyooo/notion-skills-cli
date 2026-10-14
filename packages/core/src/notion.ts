import { Context, Crypto, Effect, Layer, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { ApiErrorSchema, decode, fail, property, SkillsError } from "./model.ts"
import { configuredToken, sha256, Store } from "./store.ts"

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
  if (/timed? ?out|timeout/i.test(stderr)) return "timeout"
  if (/dns|resolve|name.*resolution|ENOTFOUND/i.test(stderr)) return "dns"
  if (/certificate|TLS|SSL/i.test(stderr)) return "tls"
  if (/connect|network|request|transport|502|503|504/i.test(stderr)) return "network"
  return "invalid_response"
}

export const NotionLive = Layer.effect(
  Notion,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const store = yield* Store
    const crypto = yield* Crypto.Crypto
    const credential = yield* Effect.cached(
      configuredToken.pipe(Effect.provideService(Store, store)),
    )
    const executable = process.env.NTN_SKILLS_NTN_BIN ?? "ntn"
    const run = (args: readonly string[], body?: Uint8Array, token?: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make(executable, args, {
              stdin: body === undefined ? "ignore" : Stream.make(body),
              stdout: "pipe",
              stderr: "pipe",
              detached: false,
              env: { NOTION_API_TOKEN: token },
              extendEnv: true,
            }),
          )
          const [stdout, stderr, exit] = yield* Effect.all(
            [
              child.stdout.pipe(
                Stream.decodeText(),
                Stream.runFold(
                  () => "",
                  (a, b) => a + b,
                ),
              ),
              child.stderr.pipe(
                Stream.decodeText(),
                Stream.runFold(
                  () => "",
                  (a, b) => a + b,
                ),
              ),
              child.exitCode,
            ],
            { concurrency: "unbounded" },
          )
          return { stdout, stderr, exit }
        }),
      ).pipe(
        Effect.timeout("60 seconds"),
        Effect.mapError((error) =>
          fail(
            "NTN_UNAVAILABLE",
            "ntn could not complete the request. Check installation, network and authentication with ntn doctor.",
            { reason: property(error)._tag === "TimeoutError" ? "timeout" : "process" },
          ),
        ),
      )
    return {
      credentialIdentity: credential.pipe(
        Effect.flatMap((token) => sha256(token ?? "ntn-keychain")),
        Effect.provideService(Crypto.Crypto, crypto),
      ),
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
          // Stay below Notion's average request rate. Clock-based and interruptible.
          yield* Effect.sleep("350 millis")
          const args = ["api", path, "--notion-version", "2026-03-11"]
          const method = options?.method ?? (body === undefined ? "GET" : "POST")
          const mutating = method !== "GET" && path !== "v1/search" && !path.endsWith("/query")
          args.push("-X", method)
          const payload =
            body === undefined ? undefined : new TextEncoder().encode(JSON.stringify(body))
          if (payload) args.push("--data", "@-")
          if (options?.file) args.push("--file", options.file)
          for (let attempt = 0; ; attempt++) {
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
            const decoded = yield* Effect.try({
              try: () => JSON.parse(r.stdout) as unknown,
              catch: () =>
                fail(
                  mutating
                    ? "WRITE_OUTCOME_UNKNOWN"
                    : r.exit
                      ? "NOTION_REQUEST_FAILED"
                      : "INVALID_RESPONSE",
                  "ntn returned no valid API JSON. Inspect reason and exit_code; check network and authentication with ntn doctor.",
                  { path, exit_code: r.exit, reason: transportReason(r.stderr) },
                ),
            }).pipe(Effect.result)
            if (decoded._tag === "Failure") {
              const reason = property(decoded.failure.details).reason
              if (
                !mutating &&
                r.exit !== 0 &&
                ["dns", "network", "timeout"].includes(String(reason)) &&
                attempt < 3
              ) {
                yield* Effect.sleep(`${2 ** attempt} seconds`)
                continue
              }
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
                catch: () => fail("INVALID_RESPONSE", "Invalid Notion error response."),
              })
              // ntn does not expose response headers. Retry transient reads, never mutations.
              if (
                !mutating &&
                [
                  "rate_limited",
                  "internal_server_error",
                  "service_unavailable",
                  "database_connection_unavailable",
                  "gateway_timeout",
                ].includes(error.code) &&
                attempt < 3
              ) {
                yield* Effect.sleep(`${2 ** attempt} seconds`)
                continue
              }
              const codes: Record<string, string> = {
                unauthorized: "AUTH_REQUIRED",
                restricted_resource: "ACCESS_DENIED",
                object_not_found: "NOT_FOUND",
                directory_not_found: "SKILL_NOT_FOUND",
                rate_limited: "RATE_LIMITED",
              }
              return yield* Effect.fail(
                fail(
                  mutating &&
                    ![
                      "unauthorized",
                      "restricted_resource",
                      "object_not_found",
                      "validation_error",
                      "rate_limited",
                    ].includes(error.code)
                    ? "WRITE_OUTCOME_UNKNOWN"
                    : (codes[error.code] ?? "NOTION_REQUEST_FAILED"),
                  "The Notion API request failed.",
                  { path, notion_code: error.code, exit_code: r.exit },
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
                  },
                ),
              )
            return value
          }
        }),
    }
  }),
)
