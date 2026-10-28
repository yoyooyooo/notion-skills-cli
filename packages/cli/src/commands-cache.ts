import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Effect, Option } from "effect"
import { Argument, Command } from "effect/cli"

import {
  clearCache,
  databaseId,
  cacheStatus,
  garbageCollectCache,
  configuredToken,
  configuration,
  effectiveCachePolicy,
  fail,
  sha256,
} from "@notion-skills-cli/core"

import { defineCommand, withConstraints } from "../../core/src/command-schema.ts"

import {
  cacheClearConstraints,
  validateConstraints,
  databaseFlag,
  switchFlag,
  emit,
  dryRunFlag,
} from "./command-options.ts"
const cacheIdentityCommand = defineCommand("identity", { database: databaseFlag }, (options) =>
  Effect.gen(function* () {
    const config = yield* configuration
    const selector = Option.getOrUndefined(options.database)
    const database =
      selector === undefined ? undefined : yield* databaseId(selector, config.sources)
    const sources = config.sources ?? []
    const selectedSources =
      database === undefined
        ? sources
        : sources.filter((source) => source.database_id === database).slice(0, 1)
    const registrations = selectedSources
      .map((source) => [source.database_id, source.alias])
      .sort((a, b) => a[0]!.localeCompare(b[0]!) || a[1]!.localeCompare(b[1]!))
    let token = yield* configuredToken
    if (!token) {
      const result = yield* Effect.tryPromise({
        try: (signal) =>
          promisify(execFile)(
            process.env.NTN_SKILLS_NTN_BIN ?? "ntn",
            ["auth", "token", "--plain"],
            { encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024, signal },
          ),
        catch: () =>
          fail("CACHE_SCOPE_UNAVAILABLE", "The selected login cannot be identified locally."),
      })
      token = result.stdout.trim()
      if (!token || /\s/.test(token))
        return yield* Effect.fail(
          fail("CACHE_SCOPE_UNAVAILABLE", "The selected login cannot be identified locally."),
        )
    }
    const identity = yield* sha256(
      JSON.stringify([
        "catalog-identity-v2",
        yield* sha256(token),
        database ?? null,
        registrations,
        config.upstream_database ?? null,
        process.env.NOTION_WORKSPACE_ID ?? "",
        process.env.NOTION_API_BASE_URL ?? "https://api.notion.com",
        process.env.NOTION_ENV ?? "prod",
      ]),
    )
    yield* emit({ identity, catalog_max_age_ms: (yield* effectiveCachePolicy).catalog_max_age_ms })
  }),
).pipe(
  Command.withShortDescription(
    "Identify the locally selected catalog credentials without network access",
  ),
  Command.withDescription(
    "Returns an opaque identity digest for the selected credentials and remote catalog scope, plus the effective catalog TTL. --database resolves a registered alias, ID or URL locally. Working directory, command spelling, cache policy, creation preferences and sync bindings do not change identity. Uses the configured token, environment token or official ntn auth token --plain in memory. No token, account identity or current authorization is returned; ordinary reads retain online scope validation.",
  ),
)

export const cacheStatusCommand = defineCommand(
  "status",
  {
    target: Argument.String("target").pipe(Argument.optional),
    database: databaseFlag,
  },
  (config) =>
    Effect.gen(function* () {
      yield* emit(
        yield* cacheStatus(Option.getOrUndefined(config.target), {
          database: Option.getOrUndefined(config.database),
        }),
      )
    }),
).pipe(Command.withShortDescription("Inspect effective roots and cached observations offline"))
export const cacheClearCommand = defineCommand(
  "clear",
  {
    target: Argument.String("target").pipe(Argument.optional),
    all: switchFlag("all", "Retire disposable observations in every recorded scope"),
    database: databaseFlag,
    dryRun: dryRunFlag,
  },
  (config) =>
    Effect.gen(function* () {
      const target = Option.getOrUndefined(config.target)
      yield* validateConstraints(cacheClearConstraints, config)
      yield* emit(
        yield* clearCache(target, {
          all: config.all,
          database: Option.getOrUndefined(config.database),
          dryRun: config.dryRun,
        }),
      )
    }),
).pipe(
  withConstraints(cacheClearConstraints),
  Command.withShortDescription("Retire disposable SQL observations without deleting content"),
  Command.withDescription(
    "Retires latest/catalog observation rows and their generation fences. It performs no filesystem deletion or Trash operation. Pinned snapshots, content objects, bindings, plans, receipts and baselines survive.",
  ),
)
export const cacheGcCommand = defineCommand(
  "gc",
  {
    database: databaseFlag,
    online: switchFlag(
      "online",
      "Prove selected records absent from one complete refreshed catalog",
    ),
    dryRun: dryRunFlag,
  },
  (config) =>
    Effect.gen(function* () {
      yield* emit(
        yield* garbageCollectCache({
          database: Option.getOrUndefined(config.database),
          online: config.online,
          dryRun: config.dryRun,
        }),
      )
    }),
).pipe(
  Command.withShortDescription("Move unreachable historical snapshots and objects to system Trash"),
  Command.withDescription(
    "Requires a proven unreachable reference closure. Offline mode keeps every referenced historical snapshot. --online requires one complete refreshed catalog and skips incomplete or unauthorized scopes. --dry-run changes nothing.",
  ),
)
export const cacheCommand = defineCommand("cache").pipe(
  Command.withShortDescription("Inspect and retire disposable read observations"),
  Command.withSubcommands([
    cacheIdentityCommand,
    cacheStatusCommand,
    cacheClearCommand,
    cacheGcCommand,
  ]),
)
