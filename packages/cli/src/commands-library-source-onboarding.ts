import { Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { defineCommand, withConstraints } from "../../core/src/command-schema.ts"
import { fail, property } from "../../core/src/model.ts"
import { pageId } from "../../core/src/ref.ts"
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
  source: Flag.String("source").pipe(
    Flag.atLeast(0),
    Flag.withDescription(
      "Exact Source ID or page; repeat for a bounded subset, exclusive with --all",
    ),
  ),
  member: Flag.String("member").pipe(
    Flag.atLeast(0),
    Flag.withDescription(
      "Only these exact provider member keys; repeat to scope one Source without changing its shared Selection",
    ),
  ),
  all: switchFlag(
    "all",
    "Explicitly review all registered Sources, including disabled definitions",
  ),
  sourceTimeoutMs: singleton(
    "source-timeout-ms",
    "Maximum discovery time per Source; default 30000 for --all or a subset, 120000 for one Source",
  ),
  ...sourceRequestBudgets,
}
function selected(args: { source: readonly string[]; all: boolean; member: readonly string[] }) {
  return Effect.try({
    try: (): SourceOnboardingScope => {
      const sources = args.source
      if (
        sources.length > 0 === args.all ||
        sources.length > 100 ||
        new Set(sources).size !== sources.length ||
        sources.some((source) => !source.trim()) ||
        ((args.all || sources.length !== 1) && args.member.length > 0)
      )
        throw fail(
          "INVALID_ARGUMENT",
          "Choose --all or one to 100 unique --source values; --member requires exactly one Source.",
        )
      return args.all
        ? { kind: "all" }
        : sources.length === 1
          ? {
              kind: "source",
              source: sources[0]!,
              ...(args.member.length === 0 ? {} : { members: args.member }),
            }
          : { kind: "sources", sources: [...sources] }
    },
    catch: () =>
      fail(
        "INVALID_ARGUMENT",
        "Choose --all or one to 100 unique --source values; --member requires exactly one Source.",
      ),
  })
}
const selectedConstraints = [
  { kind: "exactly_one", flags: ["source", "all"] },
  { kind: "requires_absent", flag: "all", absent: ["member"] },
] as const
function scopeArgs(scope: SourceOnboardingScope): string[] {
  return scope.kind === "all"
    ? ["--all"]
    : scope.kind === "sources"
      ? scope.sources.flatMap((source) => ["--source", source])
      : [
          "--source",
          scope.source,
          ...(scope.members ?? []).flatMap((member) => ["--member", member]),
        ]
}
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
          ...scopeArgs(scope),
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
                  ...(scope.kind === "source"
                    ? ["show", scope.source]
                    : ["review", ...scopeArgs(scope)]),
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

type OnboardingResult = Effect.Success<ReturnType<typeof executeSourceOnboarding>>

/** Read-only routing is not continuation authority. Original dispatch guards
 * still own every write when the same frozen plan is explicitly applied. */
export function sourceOnboardingNext(input: {
  readonly mode: OnboardingResult["mode"]
  readonly results: readonly Pick<
    OnboardingResult["results"][number],
    "verified" | "operation_id" | "error"
  >[]
  readonly plan: string
  readonly entry: string
}) {
  const incomplete = input.results.filter((item) => !item.verified)
  const originalFailure = incomplete.length === 1 ? incomplete[0] : undefined
  const failureDetails = property(originalFailure?.error?.details)
  const failurePlan = property(property(failureDetails.recovery).original_plan)
  const failurePage =
    typeof failureDetails.skill_page_id === "string"
      ? pageId(failureDetails.skill_page_id)
      : undefined
  if (
    input.mode === "reconcile" &&
    originalFailure?.error?.code === "SHARED_CREATE_REVIEW_REQUIRED" &&
    failureDetails.original_status === "needs_review" &&
    failureDetails.original_reason_code === "SHARED_CREATE_BODY_MISMATCH" &&
    failureDetails.source_projection_version === 2 &&
    failurePage &&
    typeof originalFailure.operation_id === "string" &&
    /^skill-create-[a-f0-9]{64}$/u.test(originalFailure.operation_id) &&
    failureDetails.native_create_operation_id === originalFailure.operation_id &&
    failurePlan.operation_id === originalFailure.operation_id &&
    failurePlan.retained_in_parent_plan === true
  )
    return {
      argv: [
        "ntn-skills",
        "ctl",
        "library",
        "sources",
        "recovery",
        "review",
        input.plan,
        "--operation",
        originalFailure.operation_id,
        "--target",
        failurePage,
        "--entry",
        input.entry,
        "--output",
        `${input.plan}.${originalFailure.operation_id}.review.json`,
      ],
      read_only: true,
      reason:
        "Review this exact known retained-source failure and complete original ACK prefix without writes. Current semantic equivalence alone cannot erase its immutable failure; inspect the returned independent review before any apply.",
    }
  const originalPreview =
    input.mode === "reconcile" &&
    incomplete.length > 0 &&
    incomplete.every((item) => {
      const details = property(item.error?.details)
      const original = property(property(details.recovery).original_plan)
      return (
        (item.error?.code === "SHARED_RECORD_UNRESOLVED" ||
          item.error?.code === "SHARED_CREATE_UNRESOLVED") &&
        (details.stage === "manifest" || details.stage === "outcome") &&
        typeof item.operation_id === "string" &&
        details.native_create_operation_id === item.operation_id &&
        original.operation_id === item.operation_id &&
        original.retained_in_parent_plan === true
      )
    })
  return {
    argv: [
      "ntn-skills",
      "ctl",
      "library",
      "sources",
      input.mode === "dry-run" || originalPreview ? "onboard-apply" : "onboard-reconcile",
      input.plan,
      "--entry",
      input.entry,
      ...(originalPreview ? ["--dry-run"] : []),
    ],
    read_only: input.mode !== "dry-run",
    reason: originalPreview
      ? "A missing original manifest or completion is not a persisted rejection. Preview this same saved plan; an explicit apply still requires its original journal and native acknowledgements and refuses unknown writes. Do not generate a replacement plan."
      : input.mode === "dry-run"
        ? "Apply only the reviewed frozen actions; unresolved members remain separate. Preview alone does not establish continuation authority."
        : "Read the original child outcomes without provider rediscovery or blind replay. Run review separately for current member coverage.",
  }
}

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
          next: sourceOnboardingNext({
            mode,
            results: result.results,
            plan: args.plan,
            entry: args.entry,
          }),
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
