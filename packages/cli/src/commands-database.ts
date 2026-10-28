import { Effect, Option } from "effect"
import { Argument, Command } from "effect/cli"

import {
  addSource,
  configuration,
  discoverDatabases,
  explicitSource,
  fail,
  Store,
} from "@notion-skills-cli/core"

import { initializeDatabases } from "../../core/src/database-init.ts"

import {
  defineCommand,
  withConstraints,
  type CommandConstraint,
} from "../../core/src/command-schema.ts"

import {
  validateConstraints,
  requiredDatabaseFlag,
  databaseFlag,
  singleton,
  switchFlag,
  emit,
} from "./command-options.ts"
export const databaseList = defineCommand("list", { database: databaseFlag }, (config) =>
  Effect.gen(function* () {
    const explicit = Option.getOrUndefined(config.database)
    const result =
      explicit !== undefined
        ? { databases: [yield* explicitSource(explicit)], failures: [] }
        : yield* discoverDatabases()
    yield* emit({
      databases: result.databases,
      count: result.databases.length,
      coverage: {
        method: explicit !== undefined ? "explicit_database" : "search_and_registered",
        exhaustive: explicit !== undefined,
        failed_sources: result.failures,
        search_index_limited: explicit === undefined,
      },
    })
  }),
).pipe(
  Command.withShortDescription("List Skills Databases without querying Skill rows"),
  Command.withDescription(
    "Discover database IDs, titles, registered aliases and data sources online without querying Skill rows or downloading bodies. --database validates one ID, URL or exact registered alias; titles are display labels only. Repeated --database values fail. Search is not exhaustive; inspect coverage.failed_sources for database ID/alias/title.",
  ),
)

export const databaseRegister = defineCommand(
  "register",
  {
    alias: Argument.String("alias").pipe(
      Argument.withDescription(
        "Exact local database selection alias; independent of Skill invocation names",
      ),
    ),
    database: requiredDatabaseFlag,
  },
  (config) =>
    Effect.gen(function* () {
      yield* emit({ source: yield* addSource(config.alias, config.database) })
    }),
).pipe(
  Command.withShortDescription("Register a Skills Database in local configuration"),
  Command.withDescription(
    "Validate one Skills Database ID, URL or existing registered alias online and persist its registration in local configuration. Use the new alias with --database or ctl config set default_database. Exact aliases select one database; database titles are display labels only. Writes local configuration only; registrations supplement discovery. Re-registering a database changes its alias; an alias already used for another database fails.",
  ),
  Command.withExamples([
    {
      command: "ntn-skills ctl database register personal --database DATABASE_ID",
      description: "Register a known database; replace DATABASE_ID with its ID or URL",
    },
  ]),
)
export const databaseUnregister = defineCommand(
  "unregister",
  {
    alias: Argument.String("alias").pipe(
      Argument.withDescription("Exact case-sensitive registered database alias"),
    ),
  },
  ({ alias }) =>
    Effect.gen(function* () {
      const config = yield* configuration
      const sources = config.sources ?? []
      const removed = sources.filter((source) => source.alias === alias)
      if (removed.length === 0)
        return yield* Effect.fail(
          fail("DATABASE_NOT_FOUND", "No database is registered with this exact alias.", { alias }),
        )
      yield* (yield* Store).writeJson("config.json", {
        ...config,
        sources: sources.filter((source) => source.alias !== alias),
      })
      yield* emit({
        unregistered: removed,
        sources: sources.filter((source) => source.alias !== alias),
      })
    }),
).pipe(
  Command.withShortDescription("Remove an exact local database registration offline"),
  Command.withDescription(
    "Remove only the local alias registration. Remote databases, content and saved canonical database preferences remain intact. Unknown aliases fail without changing configuration.",
  ),
)
export const databaseInitConstraints: readonly CommandConstraint[] = []
export const databaseInit = defineCommand(
  "init",
  {
    parent: singleton(
      "parent",
      "Create scoped content and upstream tables under this exact parent page",
    ),
    contentDatabase: singleton("content-database", "Attach this exact content database ID or URL"),
    upstreamDatabase: singleton(
      "upstream-database",
      "Attach this exact upstream database ID or URL",
    ),
    operation: singleton("operation", "Resume this durable initialization operation ID"),
    setDefault: switchFlag(
      "set-default",
      "Explicitly select the content table as the default write database",
    ),
  },
  (config) =>
    Effect.gen(function* () {
      yield* validateConstraints(databaseInitConstraints, config)
      yield* emit(
        yield* initializeDatabases({
          parent: Option.getOrUndefined(config.parent),
          contentDatabase: Option.getOrUndefined(config.contentDatabase),
          upstreamDatabase: Option.getOrUndefined(config.upstreamDatabase),
          operation: Option.getOrUndefined(config.operation),
          setDefault: config.setDefault,
        }),
      )
    }),
).pipe(
  withConstraints(databaseInitConstraints),
  Command.withShortDescription("Create or attach the two related content and upstream tables"),
  Command.withDescription(
    "Use --parent to create two tables, or --content-database and --upstream-database to attach exact existing IDs. Reads and validates types and relation targets before adding missing fields, including Source Type (builtin/upstream/manual), Builtin ID and the upstream Source URL column. Repeating a published initialization upgrades missing schema on the same exact tables. Source URL is derived from Source on subscription add/update; initialization does not backfill rows. Source Type records origin independently of Kind and Sync Mode; existing unclassified rows remain unset. Durable operation receipts retain exact IDs and reconcile unknown creation outcomes. Publishes configuration only after both tables verify. The default write database changes only with --set-default.",
  ),
)
export const databaseCommand = defineCommand("database").pipe(
  Command.withShortDescription("Discover Skills Databases and manage local registrations"),
  Command.withDescription(
    "list discovers accessible content databases online. init creates or attaches exact content/upstream tables and validates their native relations. register saves a content alias; unregister removes an exact alias offline.",
  ),
  Command.withSubcommands([databaseList, databaseInit, databaseRegister, databaseUnregister]),
)
