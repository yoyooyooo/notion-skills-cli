import { Effect, Stdio, Stream } from "effect"
import { Argument, Command } from "effect/cli"

import {
  Notion,
  catalog,
  configuration,
  publicConfiguration,
  setToken,
  setDefaultDatabase,
  fail,
  configureCachePolicy,
  effectiveCachePolicy,
  DEFAULT_CACHE_POLICY,
  configureBuiltinDatabase,
  Store,
} from "@notion-skills-cli/core"

import { defineCommand } from "../../core/src/command-schema.ts"

import { switchFlag, emit } from "./command-options.ts"
export const configShow = defineCommand("show", {}, () =>
  Effect.gen(function* () {
    yield* emit({
      config: {
        ...publicConfiguration(yield* configuration),
        effective_cache_policy: yield* effectiveCachePolicy,
      },
    })
  }),
).pipe(
  Command.withShortDescription("Show local configuration with token presence only"),
  Command.withDescription(
    "Read local configuration and effective cache policy offline. Token values are omitted; token_configured reports a non-empty configured token. Authentication priority: config.token > NOTION_API_TOKEN > existing ntn login. The default database affects create only; cache policy controls current reads and catalog observations.",
  ),
)
export const configurationKeys =
  "default_database, builtin_database, cache_policy.read_max_age_ms, cache_policy.catalog_max_age_ms"
export const configSet = defineCommand(
  "set",
  {
    key: Argument.String("key").pipe(
      Argument.withDescription(`Supported keys: ${configurationKeys}`),
    ),
    value: Argument.String("value").pipe(
      Argument.withDescription(
        "Database ID/URL/registered alias, or nonnegative integer cache milliseconds",
      ),
    ),
  },
  ({ key, value }) =>
    Effect.gen(function* () {
      if (key === "default_database") {
        yield* emit({ config: publicConfiguration(yield* setDefaultDatabase(value)) })
        return
      }
      if (key === "builtin_database") {
        yield* emit({ config: yield* configureBuiltinDatabase(value) })
        return
      }
      if (key !== "cache_policy.read_max_age_ms" && key !== "cache_policy.catalog_max_age_ms")
        return yield* Effect.fail(
          fail(
            "INVALID_ARGUMENT",
            `Supported configuration keys: ${configurationKeys}. Use set-token --stdin for credentials.`,
          ),
        )
      const milliseconds = Number(value)
      if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(milliseconds))
        return yield* Effect.fail(
          fail(
            "INVALID_ARGUMENT",
            "Cache policy values must be nonnegative safe integer milliseconds.",
          ),
        )
      yield* emit({
        config: yield* configureCachePolicy(
          key === "cache_policy.read_max_age_ms"
            ? { readMaxAge: milliseconds }
            : { catalogMaxAge: milliseconds },
        ),
      })
    }),
).pipe(
  Command.withShortDescription(
    "Set one supported preference; database values are validated online",
  ),
)
export const configUnset = defineCommand(
  "unset",
  {
    key: Argument.String("key").pipe(
      Argument.withDescription(`Supported keys: ${configurationKeys}`),
    ),
  },
  ({ key }) =>
    Effect.gen(function* () {
      if (key === "default_database") {
        yield* emit({ config: publicConfiguration(yield* setDefaultDatabase()) })
        return
      }
      if (key === "builtin_database") {
        yield* emit({ config: yield* configureBuiltinDatabase() })
        return
      }
      if (key !== "cache_policy.read_max_age_ms" && key !== "cache_policy.catalog_max_age_ms")
        return yield* Effect.fail(
          fail(
            "INVALID_ARGUMENT",
            `Supported configuration keys: ${configurationKeys}. Use clear-token for credentials.`,
          ),
        )
      yield* emit({
        config: yield* configureCachePolicy(
          key === "cache_policy.read_max_age_ms"
            ? { readMaxAge: DEFAULT_CACHE_POLICY.read_max_age_ms }
            : { catalogMaxAge: DEFAULT_CACHE_POLICY.catalog_max_age_ms },
        ),
      })
    }),
).pipe(
  Command.withShortDescription("Remove a database preference or restore one cache default offline"),
)
export const configSetToken = defineCommand(
  "set-token",
  {
    stdin: switchFlag(
      "stdin",
      "Required: read the token from piped standard input, never command arguments",
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const stdio = yield* Stdio.Stdio
      if (!config.stdin || (yield* stdio.stdinIsTerminal))
        return yield* Effect.fail(
          fail("INVALID_ARGUMENT", "Pipe the token into ctl config set-token --stdin."),
        )
      const input = yield* stdio.stdin.pipe(
        Stream.decodeText(),
        Stream.runFold(
          () => "",
          (text, chunk) => text + chunk,
        ),
        Effect.mapError(() =>
          fail("INPUT_FAILED", "Could not read the token from standard input."),
        ),
      )
      yield* emit({ config: yield* setToken(input) })
    }),
).pipe(
  Command.withShortDescription("Store the token from standard input in local configuration"),
  Command.withDescription(
    "Read one token from piped stdin with --stdin; trim surrounding whitespace and reject empty/multiple values. Store config.token with private file permissions while preserving sources/default_database. Works offline; no Notion request or credential validation. Output only reports token_configured. Config token takes priority over NOTION_API_TOKEN and existing ntn login.",
  ),
  Command.withExamples([
    {
      command: "ntn-skills ctl config set-token --stdin",
      description:
        "Pipe one token from a trusted secret source into this command; do not put it in arguments",
    },
  ]),
)
export const configClearToken = defineCommand("clear-token", {}, () =>
  Effect.gen(function* () {
    yield* emit({ config: yield* setToken() })
  }),
).pipe(
  Command.withShortDescription("Remove config.token and use environment/ntn login fallback"),
  Command.withDescription(
    "Remove only the configured token offline, preserving sources/default_database. Future online requests use NOTION_API_TOKEN or existing ntn login. Output never includes a token.",
  ),
  Command.withExamples([
    {
      command: "ntn-skills ctl config clear-token",
      description: "Remove the configuration token and restore environment/login fallback",
    },
  ]),
)
export const configCommand = defineCommand("config").pipe(
  Command.withShortDescription("Manage local authentication and database preferences"),
  Command.withDescription(
    `Configuration: NTN_SKILLS_CONFIG_HOME > XDG_CONFIG_HOME/ntn-skills > ~/.config/ntn-skills. Supported set/unset keys: ${configurationKeys}. Cache values are integer milliseconds; unset restores the corresponding built-in default. Database set validates online; unset works offline. Use set-token --stdin and clear-token for credentials. All output omits token values. default_database applies to create; builtin_database overrides it only for first builtin publication. No Notion writes.`,
  ),
  Command.withSubcommands([configShow, configSetToken, configClearToken, configSet, configUnset]),
)
