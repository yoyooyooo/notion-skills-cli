import { Effect, FileSystem, Option } from "effect"
import { Argument, Command } from "effect/cli"
import { defineCommand } from "../../core/src/command-schema.ts"
import { fail, SkillsError } from "../../core/src/model.ts"
import { Notion } from "../../core/src/notion.ts"
import {
  inspectGraphRelease,
  prepareGraphRelease,
  restoreGraphRelease,
  saveGraphRelease,
} from "../../core/src/shared-graph-release.ts"
import { emit, requiredSingleton, singleton, switchFlag } from "./command-options.ts"

const entry = requiredSingleton("entry", "Exact shared library Skills database entry")
const input = requiredSingleton(
  "input",
  "JSON file containing the complete public preparation or graph plan",
)
function readInput(path: string) {
  return Effect.gen(function* () {
    const raw = yield* (yield* FileSystem.FileSystem)
      .readFileString(path)
      .pipe(
        Effect.mapError(() =>
          fail("INVALID_INPUT", "The complete graph JSON input cannot be read."),
        ),
      )
    return yield* Effect.try({
      try: (): unknown => JSON.parse(raw),
      catch: () => fail("INVALID_INPUT", "The graph input must be valid JSON."),
    })
  })
}
const integer = (value: Option.Option<string>, flag: string) => {
  const text = Option.getOrUndefined(value)
  if (text === undefined) return undefined
  if (!/^(0|[1-9][0-9]*)$/u.test(text) || !Number.isSafeInteger(Number(text)))
    throw fail("INVALID_ARGUMENT", `${flag} requires a nonnegative safe integer.`)
  return Number(text)
}
const plan = defineCommand(
  "plan",
  {
    entry,
    input,
    includeMembers: switchFlag(
      "include-members",
      "Explicitly prepare the complete recursive Members set as well as Requires",
    ),
    maxNodes: singleton(
      "max-nodes",
      "Maximum frozen node count, including explicitly selected optional nodes (default 64)",
    ),
    maxDepth: singleton(
      "max-depth",
      "Maximum Requires depth and Members expansion depth (default 16)",
    ),
    maxBytes: singleton(
      "max-bytes",
      "Maximum complete file bytes across all frozen nodes (default 134217728)",
    ),
    maxInstructionBytes: singleton(
      "max-instruction-bytes",
      "Maximum bytes in one main instruction (default 1048576)",
    ),
    maxContextBytes: singleton(
      "max-context-bytes",
      "Maximum public preparation JSON bytes (default 1048576)",
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const budget = yield* Effect.try({
        try: () =>
          Object.fromEntries(
            [
              ["maxNodes", integer(config.maxNodes, "--max-nodes")],
              ["maxDepth", integer(config.maxDepth, "--max-depth")],
              ["maxBytes", integer(config.maxBytes, "--max-bytes")],
              [
                "maxInstructionBytes",
                integer(config.maxInstructionBytes, "--max-instruction-bytes"),
              ],
              ["maxContextBytes", integer(config.maxContextBytes, "--max-context-bytes")],
            ].filter(([, value]) => value !== undefined),
          ),
        catch: (error) =>
          error instanceof SkillsError ? error : fail("INVALID_ARGUMENT", "Invalid graph budget."),
      })
      const plan = yield* prepareGraphRelease(yield* readInput(config.input), {
        entry: config.entry,
        includeMembers: config.includeMembers,
        budget,
      })
      yield* emit({
        plan,
        graph_id: plan.graph_id,
        selection: plan.manifest.selection,
        nodes: plan.nodes.length,
        files: plan.nodes.reduce((sum, node) => sum + node.snapshot.files.length, 0),
        bytes: plan.nodes.reduce(
          (sum, node) => sum + node.snapshot.files.reduce((bytes, file) => bytes + file.bytes, 0),
          0,
        ),
        retained: false,
        request_metrics: (yield* Notion).requestMetrics?.(),
      })
    }),
).pipe(
  Command.withDescription(
    "Freeze a reviewable plan from a successful use preparation, graph_lock, or {graphs:[graph_lock,...]}. Selected roots and their exact Requires closure are retained by default; directory-only Members and native references do not acquire bodies. --include-members explicitly expands Members through the normal preparation path with separate count, depth, context and complete-byte budgets. The plan contains original immutable byte objects but does not publish a graph release. Save the complete JSON for save/reconcile.",
  ),
)
const save = defineCommand(
  "save",
  {
    entry,
    input,
    reconcile: switchFlag(
      "reconcile",
      "Observe the exact original graph publication without repeating unknown writes",
    ),
    allowLocalArchive: switchFlag(
      "allow-local-archive",
      "Authorize sharing this exact graph's locally sourced resource bytes",
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const result = yield* saveGraphRelease(yield* readInput(config.input), config)
      yield* emit({ ...result, request_metrics: (yield* Notion).requestMetrics?.() })
    }),
).pipe(
  Command.withDescription(
    "Retain each exact complete node snapshot through the existing Records byte protocol, then publish one library-level graph manifest. The original dispatch plan fences every write; an interrupted or unknown operation is only reconciled on retry. Existing pin manifests are not proof of currently available objects. No current bodies or upstream versions replace the frozen input. Completed local graph receipts protect pinned snapshots and objects from cache GC.",
  ),
)
const inspect = defineCommand("inspect", { graph: Argument.String("graph-id"), entry }, (config) =>
  Effect.gen(function* () {
    const result = yield* inspectGraphRelease(config.graph, config)
    yield* emit({ ...result, request_metrics: (yield* Notion).requestMetrics?.() })
  }),
).pipe(
  Command.withDescription(
    "Validate current access, the exact graph record, its version vector and every retained complete node manifest. Reads no node byte objects and does not claim local files are ready or instructions loaded. Missing, conflicting or cross-library history fails without falling back to current content.",
  ),
)
const restore = defineCommand(
  "restore",
  {
    graph: Argument.String("graph-id"),
    entry,
    materialize: singleton("materialize", "Choose manifest, entrypoints or all (default all)"),
  },
  (config) =>
    Effect.gen(function* () {
      const materialize = Option.getOrElse(config.materialize, () => "all")
      if (materialize !== "manifest" && materialize !== "entrypoints" && materialize !== "all")
        return yield* Effect.fail(
          fail("INVALID_ARGUMENT", "--materialize requires manifest, entrypoints or all."),
        )
      const result = yield* restoreGraphRelease(config.graph, { entry: config.entry, materialize })
      yield* emit({ ...result, request_metrics: (yield* Notion).requestMetrics?.() })
    }),
).pipe(
  Command.withDescription(
    "Authenticate on this machine and restore exact retained graph manifests. The default all mode verifies every historical object. --materialize manifest fetches metadata only; entrypoints fetches only main instructions. Missing resources are later fetched by exact pinned read; files lists the complete manifest and export --projection snapshot requires every file. Partial states never publish a complete snapshot. Current pages validate identity and access only. Returns producer and current-scope vectors; same scopes keep identical pins. Materialization is separate from instruction delivery or loaded state.",
  ),
)

export const libraryGraphCommand = defineCommand("graph").pipe(
  Command.withShortDescription("Explicitly retain and restore a selected immutable graph"),
  Command.withSubcommands([plan, save, inspect, restore]),
)
