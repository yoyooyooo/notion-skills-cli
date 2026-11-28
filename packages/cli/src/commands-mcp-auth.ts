import { execFile } from "node:child_process"
import { Effect, Option, Stdio, Stream } from "effect"
import { Command } from "effect/cli"
import { defineCommand } from "../../core/src/command-schema.ts"
import { fail, SkillsError } from "../../core/src/model.ts"
import {
  mcpAuthStatus,
  mcpLogin,
  mcpLogout,
  mcpSetToken,
  type McpAuthorizationRequest,
} from "./sdk.ts"
import { emit, singleton, switchFlag } from "./command-options.ts"

const profileFlag = singleton(
  "profile",
  "Select the local MCP connection profile (default: default)",
)
const expected = (error: unknown) =>
  error instanceof SkillsError
    ? error
    : fail("MCP_AUTH_FAILED", "Notion MCP authentication could not complete.")

async function presentAuthorization(
  request: McpAuthorizationRequest,
  manual: boolean,
): Promise<void> {
  if (request.signal.aborted || Date.now() >= request.deadline)
    throw fail("MCP_AUTH_CANCELLED", "Notion MCP authorization was cancelled.")
  if (manual) {
    process.stderr.write(`Open this authorization URL in your browser:\n${request.url}\n`)
    return
  }
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "rundll32.exe"
        : "xdg-open"
  const args =
    process.platform === "win32" ? ["url.dll,FileProtocolHandler", request.url] : [request.url]
  await new Promise<void>((resolve, reject) => {
    execFile(command, args, { signal: request.signal }, (error) =>
      error
        ? reject(
            fail(
              "MCP_BROWSER_UNAVAILABLE",
              "Could not open the authorization browser. Run auth mcp login --no-browser to open the URL yourself.",
            ),
          )
        : resolve(),
    )
  })
  process.stderr.write(
    "Complete Notion MCP authorization in the browser. Press Ctrl-C to cancel.\n",
  )
}

const login = defineCommand(
  "login",
  {
    profile: profileFlag,
    noBrowser: switchFlag(
      "no-browser",
      "Print the authorization URL for manual opening instead of launching a browser",
    ),
  },
  ({ profile, noBrowser }) =>
    Effect.gen(function* () {
      const mcp = yield* Effect.tryPromise({
        try: (signal) =>
          mcpLogin({
            profile: Option.getOrUndefined(profile),
            signal,
            onAuthorize: (request) => presentAuthorization(request, noBrowser),
          }),
        catch: expected,
      })
      yield* emit({ mcp })
    }),
).pipe(
  Command.withDescription(
    "Explicitly authorize hosted Notion MCP with a five-minute bounded browser flow. Credentials stay in the private local MCP store. REST credentials are neither required nor reused. An existing explicit MCP token must be cleared before OAuth login.",
  ),
)

const status = defineCommand("status", { profile: profileFlag }, ({ profile }) =>
  Effect.gen(function* () {
    const mcp = yield* Effect.tryPromise({
      try: (signal) => mcpAuthStatus({ profile: Option.getOrUndefined(profile), signal }),
      catch: expected,
    })
    yield* emit({ mcp })
  }),
).pipe(
  Command.withDescription(
    "Read local MCP credential presence and grant state without network access. Never prints tokens or OAuth codes.",
  ),
)

const logout = defineCommand("logout", { profile: profileFlag }, ({ profile }) =>
  Effect.gen(function* () {
    const mcp = yield* Effect.tryPromise({
      try: (signal) => mcpLogout({ profile: Option.getOrUndefined(profile), signal }),
      catch: expected,
    })
    yield* emit({ mcp })
  }),
).pipe(
  Command.withDescription(
    "Clear the saved OAuth grant and retire in-flight work for this connection. Explicit environment/stored MCP tokens remain separately configured.",
  ),
)

const setToken = defineCommand(
  "set-token",
  {
    profile: profileFlag,
    stdin: switchFlag("stdin", "Required: read one MCP token from piped standard input"),
  },
  ({ profile, stdin }) =>
    Effect.gen(function* () {
      const stdio = yield* Stdio.Stdio
      if (!stdin || (yield* stdio.stdinIsTerminal))
        return yield* Effect.fail(
          fail("INVALID_ARGUMENT", "Pipe one MCP token into auth mcp set-token --stdin."),
        )
      let bytes = 0
      const token = yield* stdio.stdin.pipe(
        Stream.mapEffect((chunk) => {
          bytes += chunk.byteLength
          return bytes > 16_386
            ? Effect.fail(fail("INVALID_ARGUMENT", "The MCP token input exceeds its size limit."))
            : Effect.succeed(chunk)
        }),
        Stream.decodeText(),
        Stream.runFold(
          () => "",
          (text, chunk) => text + chunk,
        ),
        Effect.mapError(() =>
          fail("INPUT_FAILED", "Could not read one bounded MCP token from standard input."),
        ),
      )
      const mcp = yield* Effect.tryPromise({
        try: (signal) => mcpSetToken(token, { profile: Option.getOrUndefined(profile), signal }),
        catch: expected,
      })
      yield* emit({ mcp })
    }),
).pipe(
  Command.withDescription(
    "Save a separate explicit MCP token from stdin. NOTION_MCP_TOKEN takes priority, then the stored MCP token, then OAuth. Invalid explicit tokens never fall back to OAuth.",
  ),
)

const clearToken = defineCommand("clear-token", { profile: profileFlag }, ({ profile }) =>
  Effect.gen(function* () {
    const mcp = yield* Effect.tryPromise({
      try: (signal) => mcpSetToken(undefined, { profile: Option.getOrUndefined(profile), signal }),
      catch: expected,
    })
    yield* emit({ mcp })
  }),
).pipe(
  Command.withDescription(
    "Clear only the stored explicit MCP token. An environment token still takes priority; otherwise a saved OAuth grant can become active.",
  ),
)

export const authCommand = defineCommand("auth").pipe(
  Command.withDescription("Manage authentication independently of content and REST configuration."),
  Command.withSubcommands([
    defineCommand("mcp").pipe(
      Command.withDescription("Manage the hosted Notion MCP connection."),
      Command.withSubcommands([login, status, logout, setToken, clearToken]),
    ),
  ]),
)
