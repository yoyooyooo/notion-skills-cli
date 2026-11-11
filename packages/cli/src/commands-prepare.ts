import { Effect, FileSystem, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { decode, fail, SkillsError } from "../../core/src/model.ts"
import { defineCommand, withConstraints } from "../../core/src/command-schema.ts"
import { prepareGraph } from "../../core/src/graph-prepare.ts"
import { normalizePrepareExecution } from "../../core/src/preparation-execution.ts"
import { Notion } from "../../core/src/notion.ts"
import {
  PrepareSessionBindingsSchema,
  type PrepareInput,
} from "../../core/src/graph-prepare-model.ts"
import {
  databaseFlag,
  emit,
  readPolicy,
  readPolicyConstraint,
  readPolicyFlags,
  singleton,
  switchFlag,
} from "./command-options.ts"

const integer = (value: Option.Option<string>, flag: string) => {
  const text = Option.getOrUndefined(value)
  if (text === undefined) return undefined
  if (!/^(0|[1-9][0-9]*)$/u.test(text) || !Number.isSafeInteger(Number(text)))
    throw fail("INVALID_ARGUMENT", `${flag} requires a nonnegative safe integer.`)
  return Number(text)
}
const readBindings = (filename: string) =>
  Effect.gen(function* () {
    const raw = yield* (yield* FileSystem.FileSystem)
      .readFileString(filename)
      .pipe(
        Effect.mapError(() =>
          fail("INVALID_INPUT", "The session bindings JSON file cannot be read."),
        ),
      )
    return yield* Effect.try({
      try: () => decode(PrepareSessionBindingsSchema, JSON.parse(raw)),
      catch: () =>
        fail(
          "INVALID_INPUT",
          "Session bindings must be the returned session_bindings array, with exact records, scope, pins and main hashes.",
        ),
    })
  })

export const prepareCommand = defineCommand(
  "prepare",
  {
    roots: Argument.String("root").pipe(
      Argument.atLeast(1),
      Argument.withDescription(
        "Exact content IDs, page URLs or pinned main refs; repeated identities share one selected version",
      ),
    ),
    purpose: Flag.Literals("purpose", ["use", "inspect"]).pipe(
      Flag.atMost(1),
      Flag.map((values) => values[0] ?? "use"),
      Flag.withDescription(
        "use prepares the complete Requires closure; inspect prepares roots and directories only (default use)",
      ),
    ),
    sessionBindings: singleton(
      "session-bindings",
      "JSON file containing the prior session_bindings array; exact existing pins remain fixed while freshness applies to new identities",
    ),
    database: databaseFlag,
    ...readPolicyFlags,
    readOnly: switchFlag(
      "read-only",
      "Forbid every remote write, including internal history retention",
    ),
    maxNodes: singleton(
      "max-nodes",
      "Maximum selected root/required nodes, excluding directory-only candidates (default 64)",
    ),
    maxDepth: singleton(
      "max-depth",
      "Maximum Requires edge depth from a root; zero allows roots only (default 16)",
    ),
    maxInstructionBytes: singleton(
      "max-instruction-bytes",
      "Maximum UTF-8 bytes in one required main instruction (default 1048576)",
    ),
    maxContextBytes: singleton(
      "max-context-bytes",
      "Maximum bytes in successful preparation JSON, including directories and graph lock, excluding optional request telemetry (default 262144)",
    ),
    priority: Flag.Literals("priority", ["required", "prefetch"]).pipe(
      Flag.atMost(1),
      Flag.map((values) => values[0] ?? "required"),
      Flag.withDescription(
        "required is foreground preparation; prefetch uses a bounded low-priority read-only execution policy",
      ),
    ),
    queueBudgetMs: singleton(
      "queue-budget-ms",
      "Maximum admission wait per request in milliseconds; prefetch defaults to 1000",
    ),
    timeBudgetMs: singleton(
      "time-budget-ms",
      "Maximum lifetime of this preparation owner in milliseconds; prefetch defaults to 5000",
    ),
    rateShare: singleton(
      "rate-share",
      "Prefetch's maximum share of the existing Notion admission rate, greater than 0 and at most 1 (default 0.1)",
    ),
    metrics: switchFlag("metrics", "Include measured Notion request metrics"),
  },
  (config) =>
    Effect.gen(function* () {
      const policy = yield* readPolicy(config)
      const budget = yield* Effect.try({
        try: () => {
          const entries = [
            ["maxNodes", integer(config.maxNodes, "--max-nodes")],
            ["maxDepth", integer(config.maxDepth, "--max-depth")],
            ["maxInstructionBytes", integer(config.maxInstructionBytes, "--max-instruction-bytes")],
            ["maxContextBytes", integer(config.maxContextBytes, "--max-context-bytes")],
          ] as const
          return Object.fromEntries(entries.filter(([, value]) => value !== undefined))
        },
        catch: (error) =>
          error instanceof SkillsError
            ? error
            : fail("INVALID_ARGUMENT", "Invalid preparation budget."),
      })
      const bindingPath = Option.getOrUndefined(config.sessionBindings)
      const execution = yield* Effect.try({
        try: () => {
          const share = Option.getOrUndefined(config.rateShare)
          return normalizePrepareExecution({
            priority: config.priority,
            queueBudgetMs: integer(config.queueBudgetMs, "--queue-budget-ms"),
            timeBudgetMs: integer(config.timeBudgetMs, "--time-budget-ms"),
            ...(share === undefined
              ? {}
              : {
                  rateShare: /^(?:0(?:\.[0-9]+)?|1(?:\.0+)?)$/u.test(share)
                    ? Number(share)
                    : Number.NaN,
                }),
          })
        },
        catch: (error) =>
          error instanceof SkillsError
            ? error
            : fail("INVALID_ARGUMENT", "Invalid preparation execution policy."),
      })
      const freshness: PrepareInput["freshness"] = policy.offline
        ? { policy: "offline" }
        : policy.refresh
          ? { policy: "refresh" }
          : policy.maxAge === undefined
            ? { policy: "default" }
            : { policy: "max_age", max_age_ms: policy.maxAge }
      const prepared = yield* prepareGraph(
        {
          roots: config.roots,
          purpose: config.purpose,
          freshness,
          budget,
          ...(bindingPath === undefined
            ? {}
            : { sessionBindings: yield* readBindings(bindingPath) }),
        },
        {
          database: Option.getOrUndefined(config.database),
          execution,
          metrics: config.metrics,
          readOnly: config.readOnly,
        },
      )
      yield* emit({
        ...prepared,
        ...(config.metrics ? { request_metrics: (yield* Notion).requestMetrics?.() } : {}),
      })
    }),
).pipe(
  withConstraints([readPolicyConstraint]),
  Command.withDescription(
    "Prepare exact roots through the shared snapshot engine. use returns ready only after every required Skill is verified; inspect reads roots and lists relationships without loading dependency bodies. Members and native references stay known candidates. Failures preserve an explicit incomplete result and never issue a graph lock. Content is never executed.",
  ),
  Command.withExamples([
    {
      command: "ntn-skills ctl prepare PAGE_ID --purpose use",
      description: "Prepare one root and its complete unconditional Requires closure",
    },
    {
      command: "ntn-skills ctl prepare PAGE_ID --purpose inspect",
      description: "Read the root and discover optional relationships without preparing candidates",
    },
    {
      command: "ntn-skills ctl prepare PINNED_MAIN_REF --session-bindings ./bindings.json",
      description: "Extend preparation while preserving the supplied session's selected versions",
    },
  ]),
)
