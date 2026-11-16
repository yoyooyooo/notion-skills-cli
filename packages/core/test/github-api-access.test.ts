import { expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { ConfigProvider, Effect, Layer, Redacted } from "effect"
import {
  GhCredential,
  GhCredentialLive,
  resolveGithubApiAccess,
  validateGithubApiBase,
} from "../src/github-api-access.ts"

test.each([
  "http://gateway.example.test/api",
  "https://user:secret@gateway.example.test/api",
  "https://gateway.example.test/api?token=secret",
  "https://gateway.example.test/api#secret",
  "https://gateway.example.test/a/../b",
  "https://gateway.example.test/%2e%2e/api",
  "https://gateway.example.test/api\\secret",
  "https://gateway.example.test/api\n",
  "file:///tmp/github-api",
  "https://gateway.example.test/%2fapi",
])("unsafe API configuration is rejected without echoing its contents: %s", (value) => {
  try {
    validateGithubApiBase(value)
    throw new Error("Unexpected acceptance")
  } catch (error) {
    expect(error).toMatchObject({ code: "GITHUB_API_CONFIG_INVALID" })
    expect(JSON.stringify(error)).not.toContain(value)
  }
})
test("API prefix normalization supports standard HTTPS and explicitly configured loopback", () => {
  expect(validateGithubApiBase("")).toBe("https://api.github.com")
  expect(validateGithubApiBase("https://gateway.example.test/github/api/v3/")).toBe(
    "https://gateway.example.test/github/api/v3",
  )
  expect(validateGithubApiBase("http://127.0.0.1:3456/api")).toBe("http://127.0.0.1:3456/api")
})

async function fixture(body: string) {
  const root = await mkdtemp(join(tmpdir(), "ntn-gh-credential-")),
    bin = join(root, "bin"),
    home = join(root, "home"),
    config = join(root, "config")
  await mkdir(bin)
  await mkdir(home)
  await mkdir(config)
  await writeFile(join(bin, "gh"), "#!/bin/sh\n" + body, { mode: 0o700 })
  const env = { PATH: bin, HOME: home, GH_CONFIG_DIR: config }
  const run = <A, E>(
    effect: Effect.Effect<A, E, GhCredential>,
    overrides: Record<string, string> = {},
  ) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(GhCredentialLive.pipe(Layer.provide(NodeServices.layer))),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ ...env, ...overrides }))),
      ),
    )
  return { root, config, env, run }
}
const tokenScript = `printf '%s\\n' "$*" >> "$GH_CONFIG_DIR/calls"\nif [ "$GH_HOST" != github.com ] || [ "$GH_PROMPT_DISABLED" != 1 ]; then exit 2; fi\nprintf 'fixture-gh-session-token\\n'\n`

test("official gh active session is queried once per operation and its value stays redacted", async () => {
  const f = await fixture(tokenScript)
  const access = await f.run(
    Effect.all([resolveGithubApiAccess, resolveGithubApiAccess, resolveGithubApiAccess], {
      concurrency: "unbounded",
    }),
  )
  expect(access.every((item) => item.authentication.kind === "gh")).toBe(true)
  const auth = access[0]!.authentication
  if (auth.kind === "anonymous") throw new Error("Expected authenticated session")
  expect(Redacted.value(auth.token)).toBe("fixture-gh-session-token")
  expect(JSON.stringify(access)).not.toContain("fixture-gh-session-token")
  expect((await readFile(join(f.config, "calls"), "utf8")).trim().split("\n")).toEqual([
    "auth token --hostname github.com",
  ])
})

test("explicit environment credentials precede gh, and custom API never asks official gh for credentials", async () => {
  const f = await fixture('printf called >> "$GH_CONFIG_DIR/calls"\nexit 2\n')
  const environment = await f.run(resolveGithubApiAccess, { GH_TOKEN: "environment-token" })
  expect(environment.authentication.kind).toBe("environment")
  const custom = await f.run(resolveGithubApiAccess, {
    NTN_SKILLS_GITHUB_API_URL: "https://gateway.example.test/api",
    GH_TOKEN: "not-for-gateway",
  })
  expect(custom.authentication.kind).toBe("anonymous")
  const explicit = await f.run(resolveGithubApiAccess, {
    NTN_SKILLS_GITHUB_API_URL: "https://gateway.example.test/api",
    NTN_SKILLS_GITHUB_TOKEN: "gateway-token",
  })
  expect(explicit.authentication.kind).toBe("dedicated")
  expect(await readFile(join(f.config, "calls"), "utf8").catch(() => null)).toBeNull()
})

test("missing gh or unsigned-in gh preserves anonymous public access without using the ambient HOME", async () => {
  const missing = await fixture(tokenScript)
  await mkdir(join(missing.root, "empty-path"))
  expect(
    (await missing.run(resolveGithubApiAccess, { PATH: join(missing.root, "empty-path") }))
      .authentication.kind,
  ).toBe("anonymous")
  expect(
    (await missing.run(resolveGithubApiAccess, { HOME: "", GH_CONFIG_DIR: "" })).authentication
      .kind,
  ).toBe("anonymous")
  expect(await readFile(join(missing.config, "calls"), "utf8").catch(() => null)).toBeNull()
  const signedOut = await fixture('printf "private diagnostic must not escape" >&2\nexit 1\n')
  expect((await signedOut.run(resolveGithubApiAccess)).authentication.kind).toBe("anonymous")
})

test("SDK-like isolated environments do not inherit another home or a host token", async () => {
  const f = await fixture(
    'if [ -n "$GH_TOKEN" ] || [ -n "$GITHUB_TOKEN" ] || [ -n "$NTN_SKILLS_GITHUB_TOKEN" ]; then exit 2; fi\nprintf "home-%s\\n" "$(/usr/bin/basename "$HOME")"\n',
  )
  const other = join(f.root, "second-home")
  await mkdir(other)
  const [one, two] = await Promise.all([
    f.run(resolveGithubApiAccess),
    f.run(resolveGithubApiAccess, { HOME: other }),
  ])
  if (one.authentication.kind === "anonymous" || two.authentication.kind === "anonymous")
    throw new Error("Expected isolated sessions")
  expect(Redacted.value(one.authentication.token)).toBe("home-home")
  expect(Redacted.value(two.authentication.token)).toBe("home-second-home")
})

test.each(['printf "bad token\\n"\n', 'printf "secret stderr" >&2\nexit 2\n'])(
  "invalid gh output is sanitized and cannot trigger credential fallback",
  async (body) => {
    const f = await fixture(body)
    const result = await f.run(resolveGithubApiAccess.pipe(Effect.result))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Success") throw new Error("Expected sanitized failure")
    expect(result.failure.code).toBe("GITHUB_AUTH_LOOKUP_FAILED")
    expect(JSON.stringify(result.failure)).not.toMatch(/bad token|secret stderr/)
  },
)

test("anonymous mode opts out of gh and ambient tokens, and rejects a conflicting dedicated credential", async () => {
  const f = await fixture("exit 2\n")
  expect(
    (
      await f.run(resolveGithubApiAccess, {
        NTN_SKILLS_GITHUB_AUTH: "anonymous",
        GH_TOKEN: "ambient",
      })
    ).authentication.kind,
  ).toBe("anonymous")
  await expect(
    f.run(resolveGithubApiAccess, {
      NTN_SKILLS_GITHUB_AUTH: "anonymous",
      NTN_SKILLS_GITHUB_TOKEN: "explicit",
    }),
  ).rejects.toMatchObject({ code: "GITHUB_AUTH_CONFIG_INVALID" })
})
