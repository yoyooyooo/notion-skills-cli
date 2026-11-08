import { Effect, Option } from "effect"
import { Argument, Command } from "effect/cli"
import { defineCommand, withConstraints } from "../../core/src/command-schema.ts"
import { fail, property } from "../../core/src/model.ts"
import {
  runSourceUpdate,
  reportSourceUpdateRun,
  listSourceUpdateRuns,
  type SourceUpdateRun,
} from "../../core/src/shared-source-run.ts"
import { Store } from "../../core/src/store.ts"
import { emit, requiredSingleton, singleton, switchFlag } from "./command-options.ts"

export const sourceRequestBudgets = {
  requests: singleton(
    "max-requests",
    "Maximum actual HTTP attempts including retries; default 2000",
  ),
  bytes: singleton(
    "max-bytes",
    "HTTP payload byte admission budget; default 134217728; admitted response overshoot is reported",
  ),
  duration: singleton(
    "duration-ms",
    "Finite invocation deadline including provider checks and local wait; default 300000 ms",
  ),
}
export function parseSourceBudget(input: {
  requests: Option.Option<string>
  bytes: Option.Option<string>
  duration: Option.Option<string>
}) {
  return Effect.try({
    try: () => {
      const positive = (value: Option.Option<string>, fallback: number) => {
        const raw = Option.getOrUndefined(value)
        if (raw === undefined) return fallback
        if (!/^[0-9]+$/u.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1)
          throw fail(
            "INVALID_ARGUMENT",
            "Request, byte and duration budgets must be positive safe integers.",
          )
        return Number(raw)
      }
      return {
        requests: positive(input.requests, 2000),
        bytes: positive(input.bytes, 128 * 1024 * 1024),
        duration_ms: positive(input.duration, 300_000),
      }
    },
    catch: () =>
      fail(
        "INVALID_ARGUMENT",
        "Request, byte and duration budgets must be positive safe integers.",
      ),
  })
}
function exitCode(run: SourceUpdateRun) {
  if (run.execution === "paused") return 75
  if (run.execution === "failed") return 1
  if (run.execution !== "completed" || run.application.some((item) => item.status === "unknown"))
    return 4
  if (run.application.some((item) => item.status !== "confirmed")) return 3
  if (
    run.request_results.some((item) => {
      const value = property(item),
        result = property(value.result)
      return (
        value.error !== undefined ||
        ["blocked", "unknown", "needs_review", "processing"].includes(String(result.status))
      )
    })
  )
    return 3
  if (property(run.source_feedback).original_outcome === "unknown") return 4
  return 0
}
export const sourceRunCommand = defineCommand(
  "run",
  {
    source: Argument.String("source"),
    entry: requiredSingleton("entry", "Exact shared Skills database with Sources attached"),
    target: singleton("target", "Exact enabled bound Skill page; exclusive with --all-bound"),
    allBound: switchFlag(
      "all-bound",
      "Process every enabled Skill in this Source's complete Origin membership",
    ),
    mode: singleton(
      "mode",
      "check, prepare, or policy; default policy. Policy honors pinned/manual/auto",
    ),
    due: switchFlag(
      "due",
      "Discover only when native check_interval_ms is due; explicit file requests are still processed in policy mode",
    ),
    storage: singleton("storage", "auto, fixed-git, or retained; default auto"),
    output: singleton(
      "output",
      "Optional new or identical frozen plan JSON; the exact plan is also retained in the run receipt",
    ),
    ...sourceRequestBudgets,
  },
  (args) =>
    Effect.gen(function* () {
      const target = Option.getOrUndefined(args.target)
      if ((target !== undefined) === args.allBound)
        return yield* Effect.fail(
          fail("INVALID_ARGUMENT", "Choose exactly one of --target or --all-bound."),
        )
      const mode = Option.getOrElse(args.mode, () => "policy")
      if (mode !== "check" && mode !== "prepare" && mode !== "policy")
        return yield* Effect.fail(fail("INVALID_ARGUMENT", "Use check, prepare, or policy mode."))
      const storage = Option.getOrElse(args.storage, () => "auto")
      if (storage !== "auto" && storage !== "fixed-git" && storage !== "retained")
        return yield* Effect.fail(
          fail("INVALID_ARGUMENT", "Use auto, fixed-git, or retained storage."),
        )
      const run = yield* runSourceUpdate({
        entry: args.entry,
        source: args.source,
        scope: target === undefined ? { kind: "all_bound" } : { kind: "skill", target },
        mode,
        dueOnly: args.due,
        storage,
        output: Option.getOrUndefined(args.output),
        budget: yield* parseSourceBudget(args),
      })
      yield* emit(run)
      process.exitCode = exitCode(run)
    }),
).pipe(
  withConstraints([
    { kind: "exactly_one", flags: ["target", "allBound"] },
    { kind: "allowed_values", flag: "mode", values: ["check", "prepare", "policy"] },
    { kind: "allowed_values", flag: "storage", values: ["auto", "fixed-git", "retained"] },
  ]),
  Command.withDescription(
    "Execute one finite source invocation. Check and prepare are remotely read-only. Policy skips discovery for disabled/pinned Sources, prepares manual candidates, and applies auto candidates only where verified protection permits. Custom bytes remain owned. Explicit registered file requests are processed even without a new commit; disabled Sources are not scanned. Same-state-root invocations share a library fence; deploy one writer per shared library across machines. No scheduler, daemon or floating branch reads are installed. Inspect the retained run with run-status and reconcile its exact plan after partial/unknown outcomes. Exit 0 completed/no blocked work; 3 review required; 4 unknown/incomplete; 75 budget pause; 1 execution failure; 2 invalid input.",
  ),
)

export const sourceRunStatusCommand = defineCommand(
  "run-status",
  {
    run: Argument.String("run-id"),
    output: singleton("output", "Export the original frozen plan to a new or identical JSON file"),
  },
  ({ run, output }) =>
    Effect.gen(function* () {
      const receipt = yield* reportSourceUpdateRun(run)
      const destination = Option.getOrUndefined(output)
      if (destination !== undefined) {
        if (receipt.plan === null)
          return yield* Effect.fail(
            fail("SOURCE_PLAN_UNAVAILABLE", "This run did not publish a complete candidate."),
          )
        yield* (yield* Store).output(
          destination,
          new TextEncoder().encode(JSON.stringify(receipt.plan, null, 2) + "\n"),
        )
      }
      yield* emit(receipt)
      process.exitCode = exitCode(receipt)
    }),
).pipe(
  Command.withDescription(
    "Read the exact original source invocation entirely offline; optionally export its frozen plan. No Notion/provider call, operation dispatch or automatic resume occurs. Retained in-progress/unknown state remains unresolved until the original operation is reconciled.",
  ),
)

export const sourceRunListCommand = defineCommand("run-list", {}, () =>
  Effect.gen(function* () {
    yield* emit(yield* listSourceUpdateRuns())
  }),
).pipe(
  Command.withDescription(
    "List retained source invocation IDs entirely offline, including checkpoints left by interrupted processes. A running checkpoint is not proof that work completed or that its last request was not dispatched.",
  ),
)
