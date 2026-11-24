import { Effect, Option } from "effect"
import { Argument, Command } from "effect/cli"

import {
  clearCache,
  selectedLibraryId,
  cacheStatus,
  garbageCollectCache,
  Notion,
  configuration,
  effectiveCachePolicy,
  sha256,
  fail,
  SkillsError,
  parseDuration,
} from "@notion-skills-cli/core"

import { defineCommand, withConstraints } from "../../core/src/command-schema.ts"
import { notionApiOrigin } from "../../core/src/notion-http.ts"
import {
  cacheRetentionReport,
  configureCacheCapacity,
  previewCacheReclamation,
  reclaimCache,
} from "../../core/src/cache-retention.ts"

import {
  cacheClearConstraints,
  validateConstraints,
  libraryFlag,
  switchFlag,
  emit,
  dryRunFlag,
  singleton,
} from "./command-options.ts"
const cacheIdentityCommand = defineCommand("identity", { library: libraryFlag }, (options) =>
  Effect.gen(function* () {
    const config = yield* configuration
    const selector = Option.getOrUndefined(options.library)
    const database = yield* selectedLibraryId(selector)
    const sources = config.sources ?? []
    const selectedSources =
      database === undefined
        ? sources
        : sources.filter((source) => source.shared_library?.library_id === database).slice(0, 1)
    const registrations = selectedSources
      .map((source) => [source.database_id, source.alias])
      .sort((a, b) => a[0]!.localeCompare(b[0]!) || a[1]!.localeCompare(b[1]!))
    const credential = yield* (yield* Notion).credentialIdentity
    const origin = yield* notionApiOrigin
    const identity = yield* sha256(
      JSON.stringify([
        "current-catalog-identity",
        credential,
        database ?? null,
        registrations,
        origin,
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
    "Returns an opaque identity digest for the selected credentials and current catalog scope, plus the effective catalog TTL. --library resolves a registered alias, ID or URL locally. Working directory, command spelling, cache policy and request timeout do not change identity. Uses the project's configured token or NOTION_API_TOKEN without a network request. No token, account identity or current authorization is returned; ordinary reads retain online scope validation.",
  ),
)

export const cacheStatusCommand = defineCommand(
  "status",
  {
    target: Argument.String("target").pipe(Argument.optional),
    library: libraryFlag,
  },
  (config) =>
    Effect.gen(function* () {
      yield* emit(
        yield* cacheStatus(Option.getOrUndefined(config.target), {
          library: Option.getOrUndefined(config.library),
        }),
      )
    }),
).pipe(Command.withShortDescription("Inspect effective roots and cached observations offline"))
export const cacheClearCommand = defineCommand(
  "clear",
  {
    target: Argument.String("target").pipe(Argument.optional),
    all: switchFlag("all", "Retire disposable observations in every recorded scope"),
    library: libraryFlag,
    dryRun: dryRunFlag,
  },
  (config) =>
    Effect.gen(function* () {
      const target = Option.getOrUndefined(config.target)
      yield* validateConstraints(cacheClearConstraints, config)
      yield* emit(
        yield* clearCache(target, {
          all: config.all,
          library: Option.getOrUndefined(config.library),
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
    library: libraryFlag,
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
          library: Option.getOrUndefined(config.library),
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
export const cacheCapacityCommand = defineCommand(
  "capacity",
  {
    maxBytes: singleton(
      "max-bytes",
      "Nonnegative integer logical bytes admitted for rebuildable SQL indexes",
    ),
    retention: singleton(
      "retention",
      "Retention preview age: 0, Ns, Nm, Nh or Nd; reads do not renew it",
    ),
  },
  (options) =>
    Effect.gen(function* () {
      const input = yield* Effect.try({
        try: () => {
          const maximum = Option.getOrUndefined(options.maxBytes)
          const retention = Option.getOrUndefined(options.retention)
          if (maximum !== undefined && !/^\d+$/u.test(maximum))
            throw fail("CACHE_CAPACITY_INVALID", "--max-bytes requires a nonnegative safe integer.")
          return {
            ...(maximum === undefined ? {} : { maxBytes: Number(maximum) }),
            ...(retention === undefined ? {} : { retentionMs: parseDuration(retention) }),
          }
        },
        catch: (error) =>
          error instanceof SkillsError
            ? error
            : fail("CACHE_CAPACITY_INVALID", "Invalid capacity input."),
      })
      yield* emit(yield* configureCacheCapacity(input))
    }),
).pipe(
  Command.withShortDescription("Inspect or set optional SQL index admission and retention"),
  Command.withDescription(
    "Defaults to 64 MiB logical payloads and 7d retention. The next runtime skips new optional Git blob, record decode and derived graph indexes over budget. Historical pins, immutable objects, current authorization and original operations remain protected and may exceed this amount. Retention produces preview candidates; it never automatically deletes. This is not a physical SQLite or whole-host disk limit.",
  ),
)

export const cacheRetentionCommand = defineCommand("retention", {}, () =>
  Effect.gen(function* () {
    yield* emit(yield* cacheRetentionReport())
  }),
).pipe(
  Command.withShortDescription(
    "Inspect local growth, owners and protection without network access",
  ),
  Command.withDescription(
    "Counts active and retired rebuildable SQL payloads, protected state, unique content objects, and allocated SQLite/WAL/SHM separately. Unknown external sessions, references and sizes remain unknown; no remote audit or write is started.",
  ),
)

export const cacheReclaimCommand = defineCommand(
  "reclaim",
  {
    apply: switchFlag(
      "apply",
      "Apply exactly one matching preview using the operating system Trash",
    ),
    plan: singleton("plan", "Exact plan_id returned by this same state root's current preview"),
  },
  (options) =>
    Effect.gen(function* () {
      const planId = Option.getOrUndefined(options.plan)
      if (options.apply !== (planId !== undefined))
        return yield* Effect.fail(
          fail("INVALID_ARGUMENT", "Use --apply and --plan together, or neither to preview."),
        )
      yield* emit(
        options.apply && planId !== undefined
          ? yield* reclaimCache({ planId })
          : yield* previewCacheReclamation(),
      )
    }),
).pipe(
  Command.withShortDescription("Preview or Trash exact rebuildable SQL cache payloads"),
  Command.withDescription(
    "Without flags, reads only. --apply --plan PLAN_ID verifies the unchanged candidate set, fsyncs and hashes an exact recovery archive, moves it to system Trash, then conditionally removes only the same rebuildable SQL rows. Trash failure leaves rows intact. No permanent filesystem deletion, VACUUM, remote deletion, content object or snapshot reclamation occurs.",
  ),
)

export const cacheCommand = defineCommand("cache").pipe(
  Command.withShortDescription("Inspect and retire disposable read observations"),
  Command.withSubcommands([
    cacheIdentityCommand,
    cacheStatusCommand,
    cacheClearCommand,
    cacheGcCommand,
    cacheCapacityCommand,
    cacheRetentionCommand,
    cacheReclaimCommand,
  ]),
)
