import { Crypto, Effect, Option, Schema, Stdio, Stream } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { libraryId } from "../../core/src/catalog.ts"
import { defineCommand, withConstraints } from "../../core/src/command-schema.ts"
import { fail, property, SkillsError } from "../../core/src/model.ts"
import { Notion } from "../../core/src/notion.ts"
import { pageId } from "../../core/src/ref.ts"
import { loadCurrentDailySkills } from "../../core/src/shared-current-daily.ts"
import { withCurrentInvocationBudget } from "../../core/src/shared-current-invocation.ts"
import { CurrentProjectionPolicySchema } from "../../core/src/shared-current-projection-policy.ts"
import { restoreCurrentSkillProjection } from "../../core/src/shared-current-projection-restore.ts"
import {
  currentProjectionPolicy,
  projectCurrentSkill,
} from "../../core/src/shared-current-projection-write.ts"
import { cancelCurrentSkillProjection } from "../../core/src/shared-current-projection-cancel.ts"
import { loadSharedLibrary } from "../../core/src/shared-library.ts"
import { emit, requiredSingleton, singleton, switchFlag } from "./command-options.ts"
import { selectCurrentWriteMode } from "./current-write-options.ts"

const readingFilter = (patterns: readonly string[] | undefined) => {
  if (patterns?.includes("")) {
    if (patterns.length !== 1)
      throw fail("INVALID_ARGUMENT", "An empty reading filter cannot be combined with patterns.")
    return []
  }
  return patterns
}

/** Admit the exact management scope before any library or body request. */
export function prepareCurrentProjectionOptions(input: {
  readonly target?: string
  readonly daily: boolean
  readonly library: string
  readonly operation?: string
  readonly resume: boolean
  readonly cancel?: boolean
  readonly restore?: boolean
  readonly include?: readonly string[]
  readonly exclude?: readonly string[]
  readonly dryRun: boolean
  readonly maxRequests?: number
  readonly maxBytes?: number
  readonly timeout?: number
}) {
  if ((input.target !== undefined) === input.daily)
    throw fail("INVALID_ARGUMENT", "Select one exact Skill page or --daily, never both.")
  if (
    input.restore &&
    (input.daily || input.operation !== undefined || input.resume || input.cancel || input.dryRun)
  )
    throw fail(
      "INVALID_ARGUMENT",
      "--restore requires one exact Skill and automatic execution without --daily, --operation, --resume, --cancel or --dry-run.",
    )
  if (
    /^notion_page:/iu.test(input.library) ||
    (/^[a-z][a-z\d+.-]*:\/\//iu.test(input.library) && !/^https?:\/\//iu.test(input.library))
  )
    throw fail("INVALID_ARGUMENT", "Projection requires an explicit current Library root.")
  if (input.daily && (input.operation !== undefined || input.resume || input.cancel))
    throw fail(
      "INVALID_ARGUMENT",
      "Daily projection continues each matching unfinished intent automatically. Use an exact Skill page for explicit --operation, --resume or --cancel.",
    )
  if (
    input.cancel &&
    (input.operation === undefined ||
      input.resume ||
      input.dryRun ||
      input.include !== undefined ||
      input.exclude !== undefined)
  )
    throw fail(
      "INVALID_ARGUMENT",
      "--cancel requires an exact --operation and cannot change policy, resume or dry-run.",
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
  const filters = { include: readingFilter(input.include), exclude: readingFilter(input.exclude) }
  return {
    scope,
    limits,
    filters,
    policy: currentProjectionPolicy(filters),
    mode: input.resume
      ? ("resume" as const)
      : input.operation === undefined && !input.dryRun
        ? ("auto" as const)
        : ("apply" as const),
  }
}

const budgetFlag = (name: string, description: string) =>
  Flag.Int(name).pipe(
    Flag.atMost(1),
    Flag.map((values) => Option.fromUndefinedOr(values[0])),
    Flag.withDescription(description),
  )

/** Recovery follows the observed intent, never the newly requested batch identity. */
export function currentProjectionRecoveryNext(
  details: unknown,
  target: string,
  entry: string,
  limits: Partial<ReturnType<typeof prepareCurrentProjectionOptions>["limits"]> = {},
  restore = false,
) {
  const current = property(details)
  if (
    (current.restore === true ||
      (current.projection === true && typeof current.operation_id === "string")) &&
    current.restore_blocked !== true
  ) {
    const policy = Schema.decodeUnknownOption(CurrentProjectionPolicySchema)(
      current.projection_policy,
      { onExcessProperty: "error" },
    )
    if (Option.isNone(policy)) return undefined
    const ownerPage =
      typeof current.skill_page_id === "string" ? pageId(current.skill_page_id) : undefined
    const restoring = restore || current.restore === true
    const execution = restoring
      ? ["--restore"]
      : typeof current.operation_id === "string"
        ? ["--operation", current.operation_id, "--resume"]
        : undefined
    if (execution === undefined) return undefined
    const filterArgs = (flag: string, patterns: readonly string[]) =>
      patterns.length === 0 ? [flag, ""] : patterns.flatMap((pattern) => [flag, pattern])
    return {
      argv: [
        "ntn-skills",
        "ctl",
        "library",
        "projection",
        ownerPage ?? target,
        "--library",
        entry,
        ...execution,
        ...filterArgs("--include", policy.value.include),
        ...filterArgs("--exclude", policy.value.exclude),
        ...(limits.requests === undefined ? [] : ["--max-requests", String(limits.requests)]),
        ...(limits.bytes === undefined ? [] : ["--max-bytes", String(limits.bytes)]),
        ...(limits.duration_ms === undefined ? [] : ["--timeout", String(limits.duration_ms)]),
      ],
      read_only: false,
      reason: restoring
        ? "Repeat this exact restoration and projection with its frozen policy."
        : "Resume this exact pending projection with its frozen policy, then rerun the daily selection if needed.",
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
        "--library",
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
    library: requiredSingleton("library", "Current Skills database ID, URL or exact registered alias"),
    daily: switchFlag(
      "daily",
      "Select Source 日用 current members, Skill 日用 and Default Context from complete current metadata",
    ),
    operation: singleton(
      "operation",
      "Exact single-Skill projection intent; required with --resume or --cancel",
    ),
    resume: switchFlag(
      "resume",
      "Continue this exact Skill intent; omitted reading filters use its frozen policy",
    ),
    cancel: switchFlag(
      "cancel",
      "Reconcile only the pending action and retire this exact reading intent without continuing it",
    ),
    restore: switchFlag(
      "restore",
      "Restore this exact trashed Skill page, then complete projection; automatic single-Skill execution only",
    ),
    include: Flag.String("include").pipe(
      Flag.atLeast(0),
      Flag.withDescription(
        "Source reading glob; repeat to replace **/*.md, or pass one empty argument for no support selection. Main and Notion-owned files remain included",
      ),
    ),
    exclude: Flag.String("exclude").pipe(
      Flag.atLeast(0),
      Flag.withDescription(
        "Source reading glob; repeat to replace default directory exclusions, or pass one empty argument for no exclusions. Consumption is unchanged",
      ),
    ),
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
            library: options.library,
            daily: options.daily,
            operation,
            resume: options.resume,
            cancel: options.cancel,
            restore: options.restore,
            include: options.include.length === 0 ? undefined : options.include,
            exclude: options.exclude.length === 0 ? undefined : options.exclude,
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
          const library = yield* loadSharedLibrary(yield* libraryId(options.library))
          if (options.cancel) {
            if (prepared.scope.kind !== "skill" || operation === undefined)
              return yield* Effect.fail(
                fail("INVALID_ARGUMENT", "Cancel one exact Skill projection operation."),
              )
            const cancelled = yield* cancelCurrentSkillProjection(library, {
              target: prepared.scope.page_id,
              operation_id: operation,
            })
            return {
              ...cancelled,
              library_id: library.library_id,
              scope: "skill",
              request_metrics: (yield* Notion).requestMetrics?.(),
            }
          }
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
            if (selected.selection !== undefined) {
              const name =
                selected.selection.skills.find((skill) => skill.page_id === target)?.name ?? target
              const stdio = yield* Stdio.Stdio
              yield* Stream.make(
                "Projection " + (results.length + 1) + "/" + targets.length + ": " + name + "\n",
              ).pipe(
                Stream.run(stdio.stderr()),
                Effect.mapError(() => fail("OUTPUT_FAILED", "Cannot report projection progress.")),
              )
            }
            const execution =
              prepared.mode === "auto"
                ? ({ mode: "auto" } as const)
                : {
                    mode: prepared.mode,
                    operation_id:
                      operation ??
                      (yield* (yield* Crypto.Crypto)
                        .randomUUIDv4()
                        .pipe(
                          Effect.mapError(() =>
                            fail("CRYPTO_ERROR", "Cannot identify this projection intent."),
                          ),
                        )),
                  }
            const policy = prepared.filters
            const project = options.restore
              ? restoreCurrentSkillProjection(library, { target, ...policy })
              : projectCurrentSkill(library, {
                  target,
                  ...execution,
                  dry_run: options.dryRun,
                  ...policy,
                })
            const result = yield* project.pipe(
              Effect.mapError((error) => {
                const next = currentProjectionRecoveryNext(
                  error.details,
                  target,
                  options.library,
                  prepared.limits,
                  options.restore,
                )
                return fail(error.code, error.message, {
                  ...property(error.details),
                  ...(next === undefined ? {} : { next }),
                  projection_scope: prepared.scope.kind,
                  failed_target: target,
                  ...(execution.mode === "auto"
                    ? {}
                    : { requested_operation_id: execution.operation_id }),
                  completed: results.map((item) => ({
                    skill_id: item.skill_id,
                    page_id: item.page_id,
                    status: item.status,
                    counts: item.counts,
                  })),
                  remaining_targets: targets.slice(results.length + 1),
                })
              }),
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
    { kind: "requires_absent", flag: "daily", absent: ["operation", "resume", "cancel"] },
    { kind: "requires_absent", flag: "cancel", absent: ["resume", "dryRun", "include", "exclude"] },
    {
      kind: "requires_absent",
      flag: "restore",
      absent: ["daily", "operation", "resume", "cancel", "dryRun"],
    },
  ]),
  Command.withDescription(
    "Reconcile human-readable Source projections: retain the main body, include Markdown by default, and exclude test, fixture, dependency and generated directories. Repeated --include/--exclude globs replace their respective defaults; one empty argument gives that filter an empty array and cannot be mixed with patterns. Create missing selected Files, update their Source descriptors, retire excluded or upstream-removed Source rows, then render complete selected text. Source manifests and Contributions retain every consumption file regardless of reading selection. Native/resource Files remain Notion authority and are preserved; native bodies are verified without replacement. Links to unprojected Source files use the fixed GitHub commit. --daily selects Source 日用 current members, Skill 日用 and Default Context; Enabled and 期望删除 are preserved. --dry-run reports full-tree counts, selection, exclusions and planned row/body changes. An equal result performs zero semantic writes. Without --operation, repeating a single-Skill or daily command automatically continues an unfinished projection only when its current target, policy and complete input fingerprint still match. --restore first restores the exact existing Skill from trash, preserving its identity, author content, flags and relations, then completes normal projection in the same invocation. It requires automatic single-Skill execution without --dry-run or manual operation flags; repeat the same --restore command after interruption. It does not recreate permanently missing content, refresh a Source ref, take over content work or restore a page trashed during an unfinished projection. Custom reading filters must be supplied again after completion; they are not persistent Skill configuration. Each Skill uses one finite operation at a time; failures leave consumption ready after restoration. Explicit --operation requires --resume to continue that intent; omitted filters then use its frozen policy. --cancel reconciles its pending action and retires only that intent, without claiming the projection is complete. Conflicts and unobserved CREATE/append outcomes stop with exact recovery coordinates; no unbounded retry or content-operation takeover occurs. Daily execution stops at the first failure. Invocation budgets cover restoration, projection, reads, writes and retries; Git internal wire traffic is not counted. Ordinary list/read/use/export/SDK/Pi never generate projections.",
  ),
  Command.withExamples([
    {
      command: "ntn-skills ctl library projection SKILL_PAGE_ID --restore --library LIBRARY_ID",
      description:
        "Restore the exact existing Skill and regenerate its complete reading projection",
    },
    {
      command: "ntn-skills ctl library projection SKILL_PAGE_ID --library LIBRARY_ID --dry-run",
      description: "Inspect selected reading documents and planned Source row changes",
    },
    {
      command: "ntn-skills ctl library projection --daily --library LIBRARY_ID",
      description: "Generate current readable bodies for every selected daily Skill",
    },
    {
      command:
        "ntn-skills ctl library projection SKILL_PAGE_ID --library LIBRARY_ID --operation PROJECTION_ID --resume",
      description: "Reconcile and continue one unfinished projection",
    },
    {
      command:
        "ntn-skills ctl library projection SKILL_PAGE_ID --library LIBRARY_ID --operation PROJECTION_ID --cancel",
      description: "Retire an exact interrupted reading intent before selecting a new policy",
    },
    {
      command:
        "ntn-skills ctl library projection SKILL_PAGE_ID --library LIBRARY_ID --include '**/*.md' --exclude '**/tests/**' --dry-run",
      description: "Inspect an explicit reading policy without changing consumption files",
    },
  ]),
)
