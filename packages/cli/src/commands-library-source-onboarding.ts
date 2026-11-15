import { Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { defineCommand, withConstraints } from "../../core/src/command-schema.ts"
import { fail } from "../../core/src/model.ts"
import { loadSharedLibrary } from "../../core/src/shared-library.ts"
import { withSourceCommandBudget } from "../../core/src/shared-source-budget.ts"
import {
  reviewSourceOnboarding,
  prepareSourceOnboarding,
  executeSourceOnboarding,
  sourceOnboardingRemaining,
} from "../../core/src/shared-source-onboarding.ts"
import type { SourceOnboardingScope } from "../../core/src/shared-source-onboarding-model.ts"
import { Store } from "../../core/src/store.ts"
import { readSourceJson } from "./command-source-input.ts"
import { emit, requiredSingleton, singleton, switchFlag } from "./command-options.ts"
import { sourceRequestBudgets, parseSourceBudget } from "./commands-library-source-run.ts"

const selection = {
  entry: requiredSingleton("entry", "Exact shared Skills database with Sources attached"),
  source: singleton("source", "Exact Source ID or page; exclusive with --all"),
  all: switchFlag(
    "all",
    "Explicitly review all registered Sources, including disabled definitions",
  ),
  sourceTimeoutMs: singleton(
    "source-timeout-ms",
    "Maximum discovery time per Source; default 30000 for --all, 120000 for one Source",
  ),
  ...sourceRequestBudgets,
}
function selected(args: { source: Option.Option<string>; all: boolean }) {
  return Effect.try({
    try: (): SourceOnboardingScope => {
      const source = Option.getOrUndefined(args.source)
      if ((source !== undefined) === args.all)
        throw fail("INVALID_ARGUMENT", "Choose exactly one of --source or --all.")
      return source === undefined ? { kind: "all" } : { kind: "source", source }
    },
    catch: () => fail("INVALID_ARGUMENT", "Choose exactly one of --source or --all."),
  })
}
const selectedConstraints = [{ kind: "exactly_one", flags: ["source", "all"] }] as const
function reviewOptions(value: Option.Option<string>) {
  const raw = Option.getOrUndefined(value)
  return raw === undefined ? {} : { sourceTimeoutMs: /^\d+$/u.test(raw) ? Number(raw) : NaN }
}

export const sourceReviewCommand = defineCommand("review", selection, (args) =>
  Effect.gen(function* () {
    const scope = yield* selected(args)
    const { result, budget } = yield* withSourceCommandBudget(
      Effect.gen(function* () {
        return yield* reviewSourceOnboarding(
          yield* loadSharedLibrary(args.entry),
          scope,
          undefined,
          reviewOptions(args.sourceTimeoutMs),
        )
      }),
      yield* parseSourceBudget(args),
    )
    yield* emit({
      ...result,
      budget,
      next: {
        argv: [
          "ntn-skills",
          "ctl",
          "library",
          "sources",
          "onboard",
          "--entry",
          args.entry,
          ...(scope.kind === "all" ? ["--all"] : ["--source", scope.source]),
          "--help",
        ],
        read_only: true,
        reason:
          "Review member decisions, then freeze safe admissions and proven missing bindings with an explicit output path.",
      },
    })
    if (sourceOnboardingRemaining(result) > 0) process.exitCode = 3
  }),
).pipe(
  withConstraints([...selectedConstraints]),
  Command.withDescription(
    "Compare complete forward Skill identities with each selected Source's configured provider members. Includes disabled Skills and reports new members, proven missing bindings, conflicts and unavailable sources. No author writes, no body refresh, no implicit admission. Registered membership does not prove content health.",
  ),
)

export const sourceOnboardCommand = defineCommand(
  "onboard",
  {
    ...selection,
    output: requiredSingleton(
      "output",
      "New or identical frozen onboarding plan JSON; retained for apply and recovery",
    ),
    storage: singleton("storage", "auto, fixed-git, or retained; default auto"),
    bind: Flag.String("bind").pipe(
      Flag.atLeast(0),
      Flag.withDescription(
        "Explicit new discovery association MEMBER=PAGE_ID for an exact review candidate; single Source only, no body/version change",
      ),
    ),
  },
  (args) =>
    Effect.gen(function* () {
      const scope = yield* selected(args)
      const bindings = yield* Effect.try({
        try: () =>
          args.bind.map((value) => {
            const at = value.lastIndexOf("=")
            if (at <= 0) throw new Error("invalid binding")
            return { member: value.slice(0, at), target: value.slice(at + 1) }
          }),
        catch: () => fail("INVALID_ARGUMENT", "Use --bind MEMBER=PAGE_ID from the current review."),
      })
      const storage = Option.getOrElse(args.storage, () => "auto")
      if (storage !== "auto" && storage !== "fixed-git" && storage !== "retained")
        return yield* Effect.fail(
          fail("INVALID_ARGUMENT", "Use auto, fixed-git or retained storage."),
        )
      const { result: plan, budget } = yield* withSourceCommandBudget(
        Effect.gen(function* () {
          return yield* prepareSourceOnboarding(yield* loadSharedLibrary(args.entry), scope, {
            storage,
            bindings,
            ...reviewOptions(args.sourceTimeoutMs),
          })
        }),
        yield* parseSourceBudget(args),
      )
      yield* (yield* Store).output(
        args.output,
        new TextEncoder().encode(JSON.stringify(plan, null, 2) + "\n"),
      )
      yield* emit({
        plan_id: plan.plan_id,
        output: args.output,
        report: plan.report,
        budget,
        remote_writes: 0,
        actions: plan.actions.map((action) =>
          action.kind === "create"
            ? {
                kind: action.kind,
                source_id: action.source.source_id,
                member: action.member,
                operation_id: action.plan.operation_id,
                skill_id: action.plan.skill_id,
                native_files: action.plan.files.length,
                enabled: false,
              }
            : {
                kind: action.kind,
                source_id: action.source.source_id,
                member: action.member,
                page_id: action.before.page_id,
                proof: action.proof,
                selected_version_preserved: action.before.selected_version,
              },
        ),
        next:
          plan.actions.length === 0
            ? {
                argv: [
                  "ntn-skills",
                  "ctl",
                  "library",
                  "sources",
                  ...(scope.kind === "source" ? ["show", scope.source] : ["review", "--all"]),
                  "--entry",
                  args.entry,
                ],
                read_only: true,
                reason:
                  "There are no applicable actions. Inspect blocked decisions or current configuration; do not apply an empty plan to claim missing members were repaired.",
              }
            : {
                argv: [
                  "ntn-skills",
                  "ctl",
                  "library",
                  "sources",
                  "onboard-apply",
                  args.output,
                  "--entry",
                  args.entry,
                  "--dry-run",
                ],
                read_only: true,
                reason:
                  "Preview this exact saved plan before authorizing its actions. Blocked members are retained in the report.",
              },
      })
      if (sourceOnboardingRemaining(plan.report) > 0) process.exitCode = 3
    }),
).pipe(
  withConstraints([
    ...selectedConstraints,
    { kind: "allowed_values", flag: "storage", values: ["auto", "fixed-git", "retained"] },
  ]),
  Command.withDescription(
    "Freeze a reusable Source-to-Skills handoff using one discovery per Source. Generate stable identities for absent members; preserve existing pages for proven fixed-source bindings. Names and equal bytes never authorize binding. New Skills stay disabled. Known conflicts and original pending creations remain blocked, not replaced. No remote writes.",
  ),
)

function executionCommand(name: "onboard-apply" | "onboard-reconcile") {
  return defineCommand(
    name,
    {
      plan: Argument.String("plan"),
      entry: requiredSingleton(
        "entry",
        "Exact shared Skills database from the saved onboarding plan",
      ),
      dryRun: switchFlag(
        "dry-run",
        "Revalidate and preview original operations without remote writes",
      ),
      ...sourceRequestBudgets,
    },
    (args) =>
      Effect.gen(function* () {
        if (name === "onboard-reconcile" && args.dryRun)
          return yield* Effect.fail(
            fail("INVALID_ARGUMENT", "Reconcile is already read-only; omit --dry-run."),
          )
        const mode = name === "onboard-reconcile" ? "reconcile" : args.dryRun ? "dry-run" : "apply"
        const plan = yield* readSourceJson(args.plan, 192 * 1024 * 1024)
        const { result, budget } = yield* withSourceCommandBudget(
          Effect.gen(function* () {
            return yield* executeSourceOnboarding(yield* loadSharedLibrary(args.entry), plan, mode)
          }),
          yield* parseSourceBudget(args),
        )
        yield* emit({
          ...result,
          budget,
          completion_scope: "frozen_actions",
          next: {
            argv: [
              "ntn-skills",
              "ctl",
              "library",
              "sources",
              mode === "dry-run" ? "onboard-apply" : "onboard-reconcile",
              args.plan,
              "--entry",
              args.entry,
            ],
            read_only: mode !== "dry-run",
            reason:
              mode === "dry-run"
                ? "Apply only the reviewed frozen actions; unresolved members remain separate."
                : "Read the original child outcomes without provider rediscovery or blind replay. Run review separately for current member coverage.",
          },
        })
        if (result.status === "partial") process.exitCode = 3
      }),
  ).pipe(
    Command.withDescription(
      name === "onboard-apply"
        ? "Apply or preview the exact saved Source handoff. Reuse original create/bind journals, preserve partial and unknown outcomes, and never refresh existing bodies or enable new members. Repeated execution cannot create a replacement for an unknown original."
        : "Reconcile the saved handoff's original operations read-only. Current equality alone is not an acknowledgement; no provider rediscovery, new plan or author write occurs.",
    ),
  )
}
export const sourceOnboardApplyCommand = executionCommand("onboard-apply")
export const sourceOnboardReconcileCommand = executionCommand("onboard-reconcile")
