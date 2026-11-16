import { Config, ConfigProvider, Context, Effect, Layer, Option, Redacted, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { fail, SkillsError } from "./model.ts"

const officialApi = "https://api.github.com"
const config = (name: string) =>
  Config.String(name).pipe(
    Config.withDefault(""),
    Effect.mapError(() => fail("CONFIG_ERROR", `Invalid ${name} configuration.`)),
  )
const secret = (name: string) =>
  Config.Redacted(name).pipe(
    Config.withDefault(Redacted.make("")),
    Effect.mapError(() => fail("CONFIG_ERROR", `Invalid ${name} credential configuration.`)),
  )

export function validateGithubApiBase(value: string) {
  if (value === "") return officialApi
  try {
    if (value.trim() !== value || /[\\\s\u0000-\u001f\u007f?#]/u.test(value)) throw new Error()
    const url = new URL(value)
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username ||
      url.password
    )
      throw new Error()
    const path = value.slice(value.indexOf("://") + 3).replace(/^[^/]*/, "")
    if (path !== url.pathname && !(path === "" && url.pathname === "/")) throw new Error()
    if (url.pathname.split("/").some((part) => part === "." || part === ".." || /%|\\/u.test(part)))
      throw new Error()
    return url.origin + url.pathname.replace(/\/+$/u, "")
  } catch {
    throw fail(
      "GITHUB_API_CONFIG_INVALID",
      "Use a credential-free HTTPS GitHub API base with an optional path prefix; only loopback may use HTTP. Queries, fragments and path traversal are forbidden.",
    )
  }
}

function checkedToken(value: Redacted.Redacted<string>) {
  const token = Redacted.value(value)
  if (token !== "" && (!/^[\x21-\x7e]+$/u.test(token) || token.length > 8192))
    throw fail(
      "GITHUB_AUTH_CONFIG_INVALID",
      "The configured GitHub credential must be a bounded nonempty header-safe token.",
    )
  return token === "" ? undefined : value
}
export class GhCredential extends Context.Service<
  GhCredential,
  {
    readonly resolve: Effect.Effect<Redacted.Redacted<string> | undefined, SkillsError>
  }
>()("ntn-skills/GhCredential") {}

export type GithubApiAccess = {
  readonly base: string
  readonly custom: boolean
  readonly explicit: boolean
  readonly authentication:
    | { readonly kind: "anonymous" }
    | {
        readonly kind: "dedicated" | "environment" | "gh"
        readonly token: Redacted.Redacted<string>
      }
}

export const githubApiConfiguration = Effect.gen(function* () {
  const raw = yield* config("NTN_SKILLS_GITHUB_API_URL")
  const base = yield* Effect.try({
    try: () => validateGithubApiBase(raw),
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("GITHUB_API_CONFIG_INVALID", "Invalid GitHub API configuration."),
  })
  const auth = yield* config("NTN_SKILLS_GITHUB_AUTH")
  if (auth !== "" && auth !== "auto" && auth !== "anonymous")
    return yield* Effect.fail(
      fail("GITHUB_AUTH_CONFIG_INVALID", "NTN_SKILLS_GITHUB_AUTH must be auto or anonymous."),
    )
  return {
    base,
    custom: base !== officialApi,
    explicit: raw !== "",
    anonymous: auth === "anonymous",
  }
})

/** API route and credentials are machine-only. Official gh/GH_TOKEN credentials
 * are never implicitly delegated to a custom gateway, even on network failure. */
export const resolveGithubApiAccess: Effect.Effect<GithubApiAccess, SkillsError> = Effect.gen(
  function* () {
    const policy = yield* githubApiConfiguration
    const dedicated = yield* secret("NTN_SKILLS_GITHUB_TOKEN")
    const selected = yield* Effect.try({
      try: () => checkedToken(dedicated),
      catch: () => fail("GITHUB_AUTH_CONFIG_INVALID", "Invalid dedicated GitHub API token."),
    })
    if (policy.anonymous) {
      if (selected !== undefined)
        return yield* Effect.fail(
          fail(
            "GITHUB_AUTH_CONFIG_INVALID",
            "Anonymous GitHub policy conflicts with an explicit dedicated token.",
          ),
        )
      return { ...policy, authentication: { kind: "anonymous" as const } }
    }
    if (selected !== undefined)
      return { ...policy, authentication: { kind: "dedicated" as const, token: selected } }
    if (policy.custom) return { ...policy, authentication: { kind: "anonymous" as const } }
    for (const key of ["GH_TOKEN", "GITHUB_TOKEN"]) {
      const value = yield* secret(key)
      const token = yield* Effect.try({
        try: () => checkedToken(value),
        catch: () =>
          fail("GITHUB_AUTH_CONFIG_INVALID", "Invalid official GitHub environment credential."),
      })
      if (token !== undefined)
        return { ...policy, authentication: { kind: "environment" as const, token } }
    }
    const provider = yield* Effect.serviceOption(GhCredential)
    if (Option.isSome(provider)) {
      const token = yield* provider.value.resolve
      if (token !== undefined) return { ...policy, authentication: { kind: "gh" as const, token } }
    }
    return { ...policy, authentication: { kind: "anonymous" as const } }
  },
)

/** Does not run gh: transport choice stays lazy when every blob is cached. */
export const preferGithubApi = Effect.gen(function* () {
  const policy = yield* githubApiConfiguration
  if (policy.explicit) return true
  if (policy.anonymous) return false
  for (const key of ["NTN_SKILLS_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"])
    if (Redacted.value(yield* secret(key)) !== "") return true
  return Option.isSome(yield* Effect.serviceOption(GhCredential))
})

function boundedOutput<E>(stream: Stream.Stream<Uint8Array, E>) {
  return Effect.suspend(() => {
    let size = 0
    const chunks: Uint8Array[] = []
    return stream.pipe(
      Stream.runForEach((chunk) => {
        size += chunk.length
        if (size > 16384)
          return Effect.fail(
            fail(
              "GITHUB_AUTH_LOOKUP_FAILED",
              "The gh credential response exceeded its bounded output limit.",
            ),
          )
        chunks.push(chunk)
        return Effect.void
      }),
      Effect.map(() => {
        const result = new Uint8Array(size)
        let at = 0
        for (const chunk of chunks) {
          result.set(chunk, at)
          at += chunk.length
        }
        return result
      }),
    )
  })
}

/** Standard-runtime adapter: one lazy noninteractive lookup per operation. The
 * complete SDK ConfigProvider, not ambient process.env, owns its child env. */
export const GhCredentialLive = Layer.effect(
  GhCredential,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner,
      provider = yield* ConfigProvider.ConfigProvider
    const resolve = yield* Effect.cached(
      Effect.gen(function* () {
        const env: Record<string, string> = {
          GH_HOST: "github.com",
          GH_PROMPT_DISABLED: "1",
          GH_NO_UPDATE_NOTIFIER: "1",
          GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
          NO_COLOR: "1",
        }
        for (const key of [
          "PATH",
          "HOME",
          "GH_CONFIG_DIR",
          "XDG_CONFIG_HOME",
          "USERPROFILE",
          "APPDATA",
          "LOCALAPPDATA",
          "SystemRoot",
          "PATHEXT",
          "TMPDIR",
          "TEMP",
          "TMP",
        ]) {
          const value = yield* config(key)
          if (value !== "") env[key] = value
        }
        // Do not let gh infer a host user's home/keychain when an SDK explicitly
        // supplied an empty or isolated environment with no credential location.
        if (
          !env.PATH ||
          (!env.GH_CONFIG_DIR && !env.HOME && !env.USERPROFILE && !env.XDG_CONFIG_HOME)
        )
          return undefined
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const child = yield* spawner.spawn(
              ChildProcess.make("gh", ["auth", "token", "--hostname", "github.com"], {
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
                detached: false,
                forceKillAfter: "1 second",
                extendEnv: false,
                env,
              }),
            )
            const [stdout, , code] = yield* Effect.all(
              [boundedOutput(child.stdout), boundedOutput(child.stderr), child.exitCode],
              { concurrency: "unbounded" },
            )
            if (code === 1) return undefined
            if (code !== 0)
              return yield* Effect.fail(
                fail(
                  "GITHUB_AUTH_LOOKUP_FAILED",
                  "The optional gh credential command failed; no credential output was retained.",
                ),
              )
            return yield* Effect.try({
              try: () => {
                const token = new TextDecoder("utf-8", { fatal: true })
                  .decode(stdout)
                  .replace(/\r?\n$/u, "")
                const value = checkedToken(Redacted.make(token))
                if (value === undefined) throw new Error()
                return value
              },
              catch: () =>
                fail(
                  "GITHUB_AUTH_LOOKUP_FAILED",
                  "gh returned an invalid credential; no credential value was retained.",
                ),
            })
          }),
        ).pipe(
          Effect.timeout("5 seconds"),
          Effect.catch((error) => {
            // Missing optional executable is a normal public-access case. Other
            // errors are sanitized; neither stdout nor stderr becomes diagnostics.
            if (
              typeof error === "object" &&
              error !== null &&
              "reason" in error &&
              typeof error.reason === "object" &&
              error.reason !== null &&
              "_tag" in error.reason &&
              error.reason._tag === "NotFound"
            )
              return Effect.succeed(undefined)
            return Effect.fail(
              error instanceof SkillsError
                ? error
                : fail(
                    "GITHUB_AUTH_LOOKUP_FAILED",
                    "The read-only gh credential lookup failed or timed out.",
                  ),
            )
          }),
        )
        return result
      }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider)),
    )
    return { resolve }
  }),
)
