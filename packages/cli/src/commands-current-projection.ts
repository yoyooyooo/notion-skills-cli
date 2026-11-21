import { Crypto, Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { databaseId } from "../../core/src/catalog.ts"
import { defineCommand, withConstraints } from "../../core/src/command-schema.ts"
import { fail, property, SkillsError } from "../../core/src/model.ts"
import { Notion } from "../../core/src/notion.ts"
import { pageId } from "../../core/src/ref.ts"
import { loadCurrentDailySkills } from "../../core/src/shared-current-daily.ts"
import { withCurrentInvocationBudget } from "../../core/src/shared-current-invocation.ts"
import { projectCurrentSkill } from "../../core/src/shared-current-projection-write.ts"
import { loadSharedLibrary } from "../../core/src/shared-library.ts"
import { emit, requiredSingleton, singleton, switchFlag } from "./command-options.ts"
import { selectCurrentWriteMode } from "./current-write-options.ts"

/** Admit the exact management scope before any library or body request. */
export function prepareCurrentProjectionOptions(input: {
  readonly target?: string
  readonly daily: boolean
  readonly entry: string
  readonly operation?: string
  readonly resume: boolean
  readonly dryRun: boolean
  readonly maxRequests?: number
  readonly maxBytes?: number
  readonly timeout?: number
}) {
  if ((input.target !== undefined) === input.daily)
    throw fail("INVALID_ARGUMENT", "Select one exact Skill page or --daily, never both.")
  if (
    /^notion_page:/iu.test(input.entry) ||
    (/^[a-z][a-z\d+.-]*:\/\//iu.test(input.entry) && !/^https?:\/\//iu.test(input.entry))
  )
    throw fail("INVALID_ARGUMENT", "Projection requires a current Skills database entry.")
  if (input.daily && (input.operation !== undefined || input.resume))
    throw fail(
      "INVALID_ARGUMENT",
      "Daily projection uses one finite intent per Skill. Resume an exact failed Skill page with its own --operation, then run --daily again.",
    )
  selectCurrentWriteMode({
    operation: input.operation,
    resume: input.resume,
    dryRun: input.dryRun,
  })
  const limits = {
    requests: input.maxRequests,
    bytes: input.maxBytes,
    duration_ms: input.timeout,
  }
  for (const [name, value] of Object.entries(limits))
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
      throw fail("INVALID_ARGUMENT", "Invocation budgets must be positive safe integers.", {
        budget: name,
      })
  const scope = input.daily
    ? ({ kind: "daily" } as const)
    : (() => {
        const page = pageId(input.target ?? "")
        if (page === undefined)
          throw fail("INVALID_ARGUMENT", "Use an exact Skill page ID or Notion page URL.")
        return { kind: "skill", page_id: page } as const
      })()
  return { scope, limits, mode: input.resume ? ("resume" as const) : ("apply" as const) }
}

const budgetFlag = (name: string, description: string) =>
  Flag.Int(name).pipe(
    Flag.atMost(1),
    Flag.map((values) => Option.fromUndefinedOr(values[0])),
    Flag.withDescription(description),
  )

/** Recovery follows the observed intent, never the newly requested batch identity. */
export function currentProjectionRecoveryNext(details: unknown, target: string, entry: string) {
  const current = property(details)
  if (current.projection === true && typeof current.operation_id === "string") {
    const ownerPage =
      typeof current.skill_page_id === "string" ? pageId(current.skill_page_id) : undefined
    return {
      argv: [
        "ntn-skills",
        "ctl",
        "library",
        "projection",
        ownerPage ?? target,
        "--entry",
        entry,
        "--operation",
        current.operation_id,
        "--resume",
      ],
      read_only: false,
      reason: "Resume this exact pending projection, then rerun the daily selection if needed.",
    }
  }
  const owner = property(current.owner)
  if ((owner.kind === "skill" || owner.kind === "source") && typeof owner.id === "string")
    return {
      argv: [
        "ntn-skills",
        "ctl",
        "library",
        "operation",
        owner.id,
        "--kind",
        owner.kind,
        "--entry",
        entry,
      ],
      read_only: true,
      reason: "Inspect the existing content operation before continuing projection.",
    }
  return undefined
}

export const currentProjectionCommand = defineCommand(
  "projection",
  {
    target: Argument.String("target").pipe(
      Argument.optional,
      Argument.withDescription("Exact Skill page ID or Notion URL; omitted only with --daily"),
    ),
    entry: requiredSingleton("entry", "Current Skills database ID, URL or exact registered alias"),
    daily: switchFlag(
      "daily",
      "Select Source 日用 current members, Skill 日用 and Default Context from complete current metadata",
    ),
    operation: singleton(
      "operation",
      "Exact single-Skill projection intent; required with --resume",
    ),
    resume: switchFlag("resume", "Reconcile and continue this exact Skill's projection intent"),
    dryRun: switchFlag(
      "dry-run",
      "Read exact originals and current full bodies, reporting missing or stale text without writes",
    ),
    maxRequests: budgetFlag(
      "max-requests",
      "Maximum HTTP attempts across the whole invocation; default 1000",
    ),
    maxBytes: budgetFlag(
      "max-bytes",
      "Maximum HTTP payload bytes across the invocation; default 536870912",
    ),
    timeout: budgetFlag("timeout", "Whole invocation deadline in ms; default 600000"),
  },
  (options) =>
    Effect.gen(function* () {
      const operation = Option.getOrUndefined(options.operation)
      const prepared = yield* Effect.try({
        try: () =>
          prepareCurrentProjectionOptions({
            target: Option.getOrUndefined(options.target),
            entry: options.entry,
            daily: options.daily,
            operation,
            resume: options.resume,
            dryRun: options.dryRun,
            maxRequests: Option.getOrUndefined(options.maxRequests),
            maxBytes: Option.getOrUndefined(options.maxBytes),
            timeout: Option.getOrUndefined(options.timeout),
          }),
        catch: (error) =>
          error instanceof SkillsError
            ? error
            : fail("INVALID_ARGUMENT", "Select one current projection scope and valid limits."),
      })
      const invocation = yield* withCurrentInvocationBudget(
        Effect.gen(function* () {
          const library = yield* loadSharedLibrary(yield* databaseId(options.entry))
          const selected = yield* prepared.scope.kind === "skill"
            ? Effect.succeed({ targets: [prepared.scope.page_id], selection: undefined })
            : loadCurrentDailySkills(library).pipe(
                Effect.map((selection) => ({
                  targets: selection.skills.map((skill) => skill.page_id),
                  selection,
                })),
              )
          const targets = selected.targets
          const results: Effect.Success<ReturnType<typeof projectCurrentSkill>>[] = []
          for (const target of targets) {
            const intent =
              operation ??
              (yield* (yield* Crypto.Crypto)
                .randomUUIDv4()
                .pipe(
                  Effect.mapError(() =>
                    fail("CRYPTO_ERROR", "Cannot identify this projection intent."),
                  ),
                ))
            const result = yield* projectCurrentSkill(library, {
              target,
              operation_id: intent,
              mode: prepared.mode,
              dry_run: options.dryRun,
            }).pipe(
              Effect.mapError((error) =>
                fail(error.code, error.message, {
                  ...property(error.details),
                  ...(currentProjectionRecoveryNext(error.details, target, options.entry) ===
                  undefined
                    ? {}
                    : {
                        next: currentProjectionRecoveryNext(error.details, target, options.entry),
                      }),
                  projection_scope: prepared.scope.kind,
                  failed_target: target,
                  requested_operation_id: intent,
                  completed: results.map((item) => ({
                    skill_id: item.skill_id,
                    page_id: item.page_id,
                    status: item.status,
                    counts: item.counts,
                  })),
                  remaining_targets: targets.slice(results.length + 1),
                }),
              ),
            )
            results.push(result)
          }
          return {
            contract: "current",
            library_id: library.library_id,
            scope: prepared.scope.kind,
            status: options.dryRun ? "inspected" : "complete",
            selection: selected.selection,
            skills: results.length,
            results,
            request_metrics: (yield* Notion).requestMetrics?.(),
          }
        }),
        prepared.limits,
      )
      yield* emit({ ...invocation.result, budget: invocation.budget })
    }),
).pipe(
  withConstraints([
    { kind: "exactly_one", flags: ["target", "daily"] },
    { kind: "requires_absent", flag: "daily", absent: ["operation", "resume"] },
  ]),
  Command.withDescription(
    "Generate or rebuild full readable text on an existing Skill page and all its text Files. Source/resource originals keep their authority, exact bytes and upstream following; native author bodies are verified without replacement. Opaque files are reported as skipped. --daily resolves the current union of Source 日用 members, Skill 日用 and Default Context with complete pagination; Enabled and 期望删除 values are reported and preserved. Each Skill uses the existing finite operation kernel, while projection failures leave current consumption ready. --dry-run compares full current bodies without writes. An equal result performs zero semantic writes. Daily execution stops at the first failure and reports completed and remaining targets; resume the exact pending Skill operation before rerunning --daily. Budgets cover the entire batch, including reads, writes and retries; Git internal wire traffic is not counted. Ordinary list/read/use/export/SDK/Pi never generate projections.",
  ),
  Command.withExamples([
    {
      command: "ntn-skills ctl library projection SKILL_PAGE_ID --entry LIBRARY_ID --dry-run",
      description: "Inspect the complete main and supporting text bodies",
    },
    {
      command: "ntn-skills ctl library projection --daily --entry LIBRARY_ID",
      description: "Generate current readable bodies for every selected daily Skill",
    },
    {
      command:
        "ntn-skills ctl library projection SKILL_PAGE_ID --entry LIBRARY_ID --operation PROJECTION_ID --resume",
      description: "Reconcile and continue one unfinished projection",
    },
  ]),
)
