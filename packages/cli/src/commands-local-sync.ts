import { Effect, Option } from "effect"
import { Argument, Command } from "effect/cli"

import {
  Notion,
  fail,
  bindSync,
  syncStatus,
  planSync,
  applySync,
  unbindSync,
} from "@notion-skills-cli/core"

import { checkLocalSync, connectLocalSync, runLocalSync } from "../../core/src/local-sync-run.ts"

import { defineCommand, withConstraints } from "../../core/src/command-schema.ts"

import {
  planConstraints,
  syncFromConstraint,
  validateConstraints,
  databaseFlag,
  singleton,
  requiredSingleton,
  switchFlag,
  refreshFlag,
  emit,
  dryRunFlag,
} from "./command-options.ts"
export const bindingArgument = Argument.String("binding").pipe(
  Argument.withDescription("Registered binding ID or exact local label"),
)
export const syncConnectCommand = defineCommand(
  "connect",
  {
    target: Argument.String("target").pipe(
      Argument.withDescription("Exact existing Notion page to synchronize"),
    ),
    path: requiredSingleton("path", "Logical local Skill directory"),
    as: singleton("as", "Unique local binding label; default is the remote invocation alias"),
    database: databaseFlag,
    from: singleton("from", "Explicit source local or notion when existing contents differ"),
    dryRun: dryRunFlag,
  },
  (config) =>
    Effect.gen(function* () {
      yield* validateConstraints([syncFromConstraint], config)
      yield* emit(
        yield* connectLocalSync(config.target, {
          path: config.path,
          as: Option.getOrUndefined(config.as),
          database: Option.getOrUndefined(config.database),
          from: Option.getOrUndefined(config.from) as "local" | "notion" | undefined,
          dryRun: config.dryRun,
        }),
      )
    }),
).pipe(
  withConstraints([syncFromConstraint]),
  Command.withShortDescription("Connect one Notion page to a local directory and synchronize"),
  Command.withDescription(
    "Register or reuse the same binding, then run its synchronization. A missing directory initializes from Notion; existing differing contents require --from local|notion. Later runs compare against the confirmed baseline. Retained receipts settle only when current observations confirm convergence; unresolved effects and conflicts preserve their original operation IDs and remain failures. --dry-run checks registration without saving a binding or copying content.",
  ),
)
export const syncBindCommand = defineCommand(
  "bind",
  {
    target: Argument.String("target"),
    path: requiredSingleton(
      "path",
      "Logical local Skill directory; an absent ordinary leaf can be initialized",
    ),
    as: singleton("as", "Unique local binding label; default is the remote invocation alias"),
    database: databaseFlag,
    dryRun: dryRunFlag,
  },
  (config) =>
    Effect.gen(function* () {
      yield* emit(
        yield* bindSync(config.target, {
          path: config.path,
          as: Option.getOrUndefined(config.as),
          database: Option.getOrUndefined(config.database),
          dryRun: config.dryRun,
        }),
      )
    }),
).pipe(
  Command.withShortDescription("Bind an existing page to one logical local directory"),
  Command.withDescription(
    "Registration validates both sides online. Equal contents initialize a confirmed common baseline; differences require an explicit direction with sync local run BINDING --from local|notion. Bind never copies content or creates a page. Historical targets and dangling links fail; --dry-run saves no binding or baseline.",
  ),
)
export const syncStatusCommand = defineCommand(
  "status",
  {
    binding: bindingArgument.pipe(Argument.optional),
    refresh: refreshFlag,
  },
  (config) =>
    Effect.gen(function* () {
      yield* emit(
        yield* syncStatus(Option.getOrUndefined(config.binding), { refresh: config.refresh }),
      )
    }),
).pipe(
  Command.withShortDescription(
    "Inspect one or all bindings; remote observations are provisional by default",
  ),
  Command.withDescription(
    "Default inspects local content, common baseline and the last cached remote observation without network. --refresh validates remote state online. Neither observation advances a common baseline.",
  ),
)
export const syncPlanCommand = defineCommand(
  "plan",
  {
    binding: bindingArgument.pipe(Argument.optional),
    all: switchFlag("all", "Plan all active bindings with shared-page and real-target checks"),
    from: singleton(
      "from",
      "Explicit source local or notion for initialization or conflict resolution",
    ),
    output: singleton(
      "output",
      "Reviewable JSON copy; identical copies reused, differing output rejected",
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const binding = Option.getOrUndefined(config.binding)
      const from = Option.getOrUndefined(config.from)
      yield* validateConstraints(planConstraints, config)
      yield* emit(
        yield* planSync(binding, {
          all: config.all,
          from: from as "local" | "notion" | undefined,
          output: Option.getOrUndefined(config.output),
        }),
      )
    }),
).pipe(
  withConstraints(planConstraints),
  Command.withShortDescription("Save a strongly checked content-addressed sync plan"),
  Command.withDescription(
    "Preview without content or baseline changes. One-sided changes select direction; differing two-sided changes fail with a retained conflict plan. --from explicitly resolves initialization/conflict and still enforces all version/path/link checks. Batch plans accept only one candidate per page and can fan out to unchanged copies.",
  ),
)
export const syncApplyCommand = defineCommand(
  "apply",
  {
    plan: requiredSingleton("plan", "Exact saved p_<sha256> plan ID or local JSON file"),
  },
  (config) =>
    Effect.gen(function* () {
      yield* emit(yield* applySync(config.plan))
    }),
).pipe(
  Command.withShortDescription("Revalidate and execute the saved plan with verified readback"),
  Command.withDescription(
    "All initial preconditions are checked before the first write. Content, baseline, binding, scope or link changes reject the plan. Confirmed convergence advances each baseline; partial/unknown results retain receipts and require reconcile before another apply. There is no force, direction override or global transaction.",
  ),
)
export const syncUnbindCommand = defineCommand(
  "unbind",
  {
    binding: bindingArgument,
    dryRun: dryRunFlag,
  },
  (config) =>
    Effect.gen(function* () {
      yield* emit(yield* unbindSync(config.binding, { dryRun: config.dryRun }))
    }),
).pipe(
  Command.withShortDescription(
    "Deactivate a binding while retaining content, plans, receipts and baseline",
  ),
)
export const syncCheckCommand = defineCommand(
  "check",
  {
    binding: bindingArgument.pipe(Argument.optional),
  },
  (config) =>
    Effect.gen(function* () {
      yield* emit(yield* checkLocalSync(Option.getOrUndefined(config.binding)))
    }),
).pipe(
  Command.withShortDescription("Observe current local and Notion content without applying changes"),
)
export const syncRunCommand = defineCommand(
  "run",
  {
    binding: bindingArgument.pipe(Argument.optional),
    all: switchFlag("all", "Run all active bindings with per-page verified outcomes"),
    from: singleton("from", "Explicit source local or notion for one binding"),
  },
  (config) =>
    Effect.gen(function* () {
      yield* validateConstraints(planConstraints, config)
      yield* emit(
        yield* runLocalSync(Option.getOrUndefined(config.binding), {
          all: config.all,
          from: Option.getOrUndefined(config.from) as "local" | "notion" | undefined,
        }),
      )
    }),
).pipe(
  withConstraints(planConstraints),
  Command.withShortDescription("Synchronize selected bindings with verified outcomes"),
  Command.withDescription(
    "Inspect retained receipts before planning the next change. Confirmed convergence can settle locally; unresolved effects or conflicting edits stop the affected target without replaying content writes. Exactly one binding or --all is required; --from selects a source only for one binding.",
  ),
)
export const syncLocalCommand = defineCommand("local").pipe(
  Command.withShortDescription(
    "Synchronize existing Notion pages and logical local Skill directories",
  ),
  Command.withSubcommands([
    syncConnectCommand,
    syncBindCommand,
    syncStatusCommand,
    syncPlanCommand,
    syncApplyCommand,
    syncUnbindCommand,
    syncCheckCommand,
    syncRunCommand,
  ]),
)
