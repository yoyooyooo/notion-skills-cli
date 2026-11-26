import { fileURLToPath } from "node:url"
import { Effect, FileSystem, Option } from "effect"
import { Command, Flag } from "effect/cli"
import { defineCommand, withConstraints } from "../../core/src/command-schema.ts"
import { fail, SkillsError } from "../../core/src/model.ts"
import {
  runCurrentSourceSync,
  validateCurrentSourceSyncCommand,
} from "../../core/src/shared-current-source-sync.ts"
import {
  currentSourceSyncExitCode,
  type CurrentSourceSyncCommand,
  type CurrentSourceSyncRequest,
} from "../../core/src/shared-current-source-sync-model.ts"
import { sha256 } from "../../core/src/store.ts"
import { emit, requiredSingleton, singleton } from "./command-options.ts"

const budgetFlag = (name: string, description: string) =>
  Flag.Int(name).pipe(
    Flag.atMost(1),
    Flag.map((values) => Option.fromUndefinedOr(values[0])),
    Flag.withDescription(description),
  )
const flags = {
  library: requiredSingleton(
    "library",
    "Library root page ID, Notion URL or exact registered alias",
  ),
  sources: Flag.String("source").pipe(
    Flag.between(1, 256),
    Flag.withDescription("Exact stable current Source ID; repeat for 1 to 256 selected Sources"),
  ),
  maxRequests: budgetFlag(
    "max-requests",
    "Positive maximum HTTP attempts for the whole batch; default 1000. Git subprocess requests are not counted",
  ),
  maxBytes: budgetFlag(
    "max-bytes",
    "Positive maximum HTTP payload bytes for the whole batch; default 536870912",
  ),
  timeout: budgetFlag(
    "timeout",
    "Positive invocation deadline in ms, including Git ref checks and acquisition; default 600000",
  ),
}

type BatchOptions = {
  readonly library: string
  readonly sources: readonly string[]
  readonly maxRequests: Option.Option<number>
  readonly maxBytes: Option.Option<number>
  readonly timeout: Option.Option<number>
}

function limits(options: BatchOptions) {
  const requests = Option.getOrUndefined(options.maxRequests)
  const bytes = Option.getOrUndefined(options.maxBytes)
  const duration_ms = Option.getOrUndefined(options.timeout)
  return {
    ...(requests === undefined ? {} : { requests }),
    ...(bytes === undefined ? {} : { bytes }),
    ...(duration_ms === undefined ? {} : { duration_ms }),
  }
}

/** A source module hash cannot identify all its imported implementation. Installed
 * commands are one frozen JS bundle; source development supplies an explicit ID. */
export function currentSourceSyncExecutionIdentity() {
  return Effect.gen(function* () {
    const path = fileURLToPath(import.meta.url)
    if (!path.endsWith(".js"))
      return yield* Effect.fail(
        fail(
          "INVALID_ARGUMENT",
          "Source development runs require --execution-id. The installed CLI defaults to its complete bundle SHA-256.",
        ),
      )
    const bytes = yield* (yield* FileSystem.FileSystem)
      .readFile(path)
      .pipe(
        Effect.mapError(() =>
          fail(
            "SOURCE_SYNC_EXECUTION_UNAVAILABLE",
            "Cannot identify this installed CLI bundle. Supply its frozen --execution-id explicitly.",
          ),
        ),
      )
    return yield* sha256(bytes)
  })
}

function runBatch(entry: string, input: CurrentSourceSyncCommand) {
  return Effect.gen(function* () {
    const command = yield* Effect.try({
      try: () => {
        if (
          !entry.trim() ||
          /^notion_page:/iu.test(entry) ||
          (/^[a-z][a-z\d+.-]*:\/\//iu.test(entry) && !/^https?:\/\//iu.test(entry))
        )
          throw fail(
            "INVALID_ARGUMENT",
            "Source management requires a current database ID or Notion URL.",
          )
        return validateCurrentSourceSyncCommand(input)
      },
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail("INVALID_ARGUMENT", "Invalid Source check or sync parameters."),
    })
    const result = yield* runCurrentSourceSync(entry, command)
    const exit = currentSourceSyncExitCode(result)
    yield* emit({ ok: exit === 0, ...result })
    process.exitCode = exit
  })
}

export const checkCurrentSourcesCommand = defineCommand("check", flags, (options) =>
  runBatch(options.library, {
    action: "check",
    source_ids: options.sources,
    limits: limits(options),
  }),
).pipe(
  Command.withDescription(
    "Read selected current Source declarations and exact upstream refs without publishing or changing Notion. One invocation shares library reads, a request budget and equal ref observations. Unfinished Source or affected target operations block the check. upstream_unchanged compares upstream and configuration only; it does not certify current target files or reading projections. Disabled, pinned and explicit fixed-commit Sources are skipped. Results are JSON on stdout. Exit 0 means complete, 75 means retryable, 1 means another incomplete result, and 2 means invalid arguments.",
  ),
  Command.withExamples([
    {
      command:
        "ntn-skills ctl library source check --library LIBRARY_ID --source team-skills --source shared-tools",
      description: "Check an explicit bounded Source set without publishing changes",
    },
  ]),
)

export const syncCurrentSourcesCommand = defineCommand(
  "sync",
  {
    ...flags,
    manager: singleton("manager", "Stable owner of this synchronization; default manual"),
    executionId: singleton(
      "execution-id",
      "Frozen implementation identity; installed CLI defaults to its complete bundle SHA-256",
    ),
    mode: singleton(
      "mode",
      "changed (default) checks upstream and previous successful configuration; full reconciles the complete current targets",
    ),
    projection: singleton("projection", "none (default) or markdown after content publication"),
  },
  (options) =>
    Effect.gen(function* () {
      const selected = yield* Effect.try({
        try: () => {
          const mode = Option.getOrElse(options.mode, () => "changed")
          const projection = Option.getOrElse(options.projection, () => "none")
          if (mode !== "changed" && mode !== "full")
            throw fail("INVALID_ARGUMENT", "Source sync mode must be changed or full.")
          if (projection !== "none" && projection !== "markdown")
            throw fail("INVALID_ARGUMENT", "Source sync projection must be none or markdown.")
          return { mode, projection } satisfies Pick<
            CurrentSourceSyncRequest,
            "mode" | "projection"
          >
        },
        catch: (error) =>
          error instanceof SkillsError
            ? error
            : fail("INVALID_ARGUMENT", "Invalid Source synchronization mode."),
      })
      const execution_id =
        Option.getOrUndefined(options.executionId) ?? (yield* currentSourceSyncExecutionIdentity())
      yield* runBatch(options.library, {
        action: "sync",
        source_ids: options.sources,
        limits: limits(options),
        manager_id: Option.getOrElse(options.manager, () => "manual"),
        execution_id,
        ...selected,
      })
    }),
).pipe(
  withConstraints([
    { kind: "allowed_values", flag: "mode", values: ["changed", "full"] },
    { kind: "allowed_values", flag: "projection", values: ["none", "markdown"] },
  ]),
  Command.withDescription(
    "Check, freeze and publish exact current Git content for an explicit Source set, reusing the existing finite Source writer. The first invocation reconciles fully; changed mode can skip unchanged upstream only with a matching successful local observation. full mode reconciles current targets even at the same commit. Optional markdown projection follows publication and remains separately reported. Repeating the same manager and execution identity with the original local Store resumes a compatible unfinished synchronization before checking newer upstream. Foreign pending work, changed frozen inputs and unknown outcomes stop with a blocked or pending result. There is one budget for the batch and no distributed lock. Scheduling and notifications belong to the caller. JSON is always written to stdout; exits are complete 0, retryable 75, other incomplete 1, usage 2.",
  ),
  Command.withExamples([
    {
      command: "ntn-skills ctl library source sync --library LIBRARY_ID --source team-skills",
      description: "Synchronize with the installed bundle identity and default manual manager",
    },
    {
      command:
        "ntn-skills ctl library source sync --library LIBRARY_ID --source team-skills --source shared-tools --manager scheduled-sync --execution-id PACKAGE_SHA256 --mode changed --projection markdown --max-requests 1000 --max-bytes 536870912 --timeout 600000",
      description: "Run a bounded scheduled batch with explicit deployment identity",
    },
  ]),
)
