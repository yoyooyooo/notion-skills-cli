import { Clock, Effect, Path } from "effect"
import { fail, property, SkillsError, validateDescription, validateDisplayName } from "./model.ts"
import { authScope, creationSource } from "./catalog.ts"
import {
  getSubscription,
  addSubscription,
  subscriptionDatabase,
  listSubscriptions,
  updateSubscriptionSync,
} from "./upstream-subscription.ts"
import { statusUpstreamObservation, checkUpstreamObservation } from "./upstream-status.ts"
import { planUpstream } from "./upstream-plan.ts"
import { applyUpstream } from "./upstream-apply.ts"
import { Store, sha256 } from "./store.ts"
import { withLocalLocks } from "./local-locks.ts"
import { pageId } from "./ref.ts"
import {
  SubscriptionInputSchema,
  strictDecode,
  type Subscription,
  type SubscriptionInput,
  type UpstreamOperation,
  type UpstreamPlan,
} from "./upstream-model.ts"
import { canonical } from "./publication-observation.ts"
import { validateGitSource, validateSourceSelection } from "./upstream-source.ts"
import { UpstreamState } from "./upstream-state.ts"
import { restoreDeletedUpstreamMembers, type RestoredUpstreamMember } from "./upstream-rebuild.ts"

type RunResult = {
  subscription_id: string
  status: "succeeded" | "partial" | "failed"
  started_at?: string
  finished_at?: string
  summary: string
  plan_id?: string
  operation?: UpstreamOperation
  recovered_operation_ids?: readonly string[]
  restored?: readonly RestoredUpstreamMember[]
  members?: ReturnType<typeof memberCounts>
  error_code?: string
  error?: { code: string; message: string; details?: unknown }
  status_error_code?: string
}
function memberCounts(
  operation: UpstreamOperation,
  plan: UpstreamPlan | undefined,
  restored: readonly RestoredUpstreamMember[],
) {
  const counts = {
    created: 0,
    updated: 0,
    unchanged: 0,
    retained: 0,
    forked: 0,
    restored: restored.length,
    conflicted: 0,
    unresolved: 0,
  }
  for (const item of operation.items) {
    if (restored.some((member) => member.member_key === item.member_key)) continue
    if (item.status === "conflict") counts.conflicted++
    else if (item.status === "retained") counts.retained++
    else if (item.status === "fork") counts.forked++
    else if (item.status !== "verified") counts.unresolved++
    else {
      const action = plan?.items.find((member) => member.member_key === item.member_key)?.action
      if (action === "create") counts.created++
      else if (action === "update") counts.updated++
      else counts.unchanged++
    }
  }
  return counts
}

function hasPendingWrites(operation: UpstreamOperation) {
  return (
    operation.state !== "verified" &&
    (operation.state === "running" ||
      operation.items.some(
        (item) =>
          item.status === "running" ||
          item.status === "unknown" ||
          (item.status === "failed" && item.publication_operation_id !== undefined),
      ) ||
      operation.projections?.entries.some((entry) => entry.status === "unknown") === true)
  )
}

type UpstreamSelection = {
  readonly targets?: readonly string[]
  readonly all?: boolean
}
export function runUpstreams(selection: UpstreamSelection) {
  return executeUpstreams(selection).pipe(Effect.map(({ result }) => result))
}

function executeUpstreams(selection: UpstreamSelection) {
  return Effect.gen(function* () {
    if ((selection.all === true) === Boolean(selection.targets?.length))
      return yield* Effect.fail(
        fail("UPSTREAM_SELECTION_REQUIRED", "Choose explicit subscription targets or --all."),
      )
    const targets = selection.all
      ? (yield* listSubscriptions)
          .filter((s) => s.enabled && !s.removed)
          .map((s) => s.subscription_id)
      : [...selection.targets!]
    const store = yield* Store
    const results: RunResult[] = []
    const subscriptions = new Map<string, Subscription>()
    for (const target of [...new Set(targets)]) {
      const result = yield* withLocalLocks(
        store.root,
        [`upstream-run:${pageId(target) ?? target}`],
        Effect.gen(function* () {
          const subscription = yield* getSubscription(target)
          if (!subscription.enabled || subscription.removed)
            return yield* Effect.fail(
              fail("UPSTREAM_DISABLED", "The subscription is disabled or removed."),
            )
          const started_at = new Date(yield* Clock.currentTimeMillis).toISOString()
          yield* updateSubscriptionSync(target, {
            status: "running",
            attempted_at: started_at,
            succeeded_at: subscription.sync?.succeeded_at ?? null,
            summary: "Fetching the source and synchronizing selected members.",
          })
          const recovered_operation_ids: string[] = []
          const restored: RestoredUpstreamMember[] = []
          const state = yield* UpstreamState
          const outcome = yield* Effect.gen(function* () {
            const scope = yield* authScope
            const retained = (yield* state.operations(subscription.subscription_id)).filter(
              (operation) =>
                operation.scope === scope &&
                operation.database_id === subscription.database_id &&
                hasPendingWrites(operation),
            )
            const pending = yield* Effect.forEach(retained, (operation) =>
              Effect.gen(function* () {
                return { operation, plan: yield* state.plan(operation.plan_id) }
              }),
            )
            pending.sort(
              (left, right) => (left.plan?.created_at ?? 0) - (right.plan?.created_at ?? 0),
            )
            for (const { operation: original } of pending) {
              const operation = yield* applyUpstream(original.plan_id).pipe(
                Effect.mapError((error) =>
                  fail(error.code, error.message, {
                    ...property(error.details),
                    operation_id: original.operation_id,
                    plan_id: original.plan_id,
                  }),
                ),
              )
              recovered_operation_ids.push(original.operation_id)
              // An unknown original write blocks a new intent; never turn retry into a second create.
              if (operation.state !== "verified") return { plan_id: original.plan_id, operation }
            }
            restored.push(...(yield* restoreDeletedUpstreamMembers(subscription.subscription_id)))
            const plan = yield* planUpstream(subscription.subscription_id)
            const operation = yield* applyUpstream(plan.plan_id)
            return { plan_id: plan.plan_id, operation }
          }).pipe(Effect.result)
          const members =
            outcome._tag === "Success"
              ? memberCounts(
                  outcome.success.operation,
                  yield* state.plan(outcome.success.plan_id),
                  restored,
                )
              : undefined
          const finished_at = new Date(yield* Clock.currentTimeMillis).toISOString()
          const status: RunResult["status"] =
            outcome._tag === "Failure"
              ? "failed"
              : outcome.success.operation.state === "verified"
                ? "succeeded"
                : "partial"
          const completed =
            outcome._tag === "Success"
              ? outcome.success.operation.items.filter((item) =>
                  ["verified", "retained", "fork"].includes(item.status),
                ).length
              : 0
          const summary =
            outcome._tag === "Failure"
              ? `${outcome.failure.code}: ${outcome.failure.message}`.slice(0, 1800)
              : `${completed}/${outcome.success.operation.items.length} members complete${status === "partial" ? "; remaining members need attention" : ""}.`
          const saved = yield* updateSubscriptionSync(target, {
            status,
            attempted_at: started_at,
            succeeded_at:
              status === "succeeded" ? finished_at : (subscription.sync?.succeeded_at ?? null),
            summary,
          }).pipe(Effect.result)
          if (saved._tag === "Success")
            subscriptions.set(subscription.subscription_id, saved.success)
          return {
            subscription_id: target,
            status: saved._tag === "Failure" ? "failed" : status,
            started_at,
            finished_at,
            summary,
            recovered_operation_ids,
            restored,
            ...(members ? { members } : {}),
            ...(outcome._tag === "Success"
              ? outcome.success
              : {
                  error_code: outcome.failure.code,
                  error: {
                    code: outcome.failure.code,
                    message: outcome.failure.message,
                    ...(outcome.failure.details === undefined
                      ? {}
                      : { details: outcome.failure.details }),
                  },
                }),
            ...(saved._tag === "Failure" ? { status_error_code: saved.failure.code } : {}),
          } satisfies RunResult
        }),
      ).pipe(Effect.result)
      results.push(
        result._tag === "Success"
          ? result.success
          : {
              subscription_id: target,
              status: "failed" as const,
              error_code: result.failure.code,
              summary: result.failure.message,
            },
      )
    }
    const succeeded = results.filter((result) => result.status === "succeeded").length
    const partial = results.filter((result) => result.status === "partial").length
    const failed = results.length - succeeded - partial
    const result = {
      verified: succeeded === results.length,
      status:
        succeeded === results.length ? "succeeded" : succeeded || partial ? "partial" : "failed",
      summary: { total: results.length, succeeded, partial, failed },
      results,
    }
    return { result, subscriptions }
  })
}
export const statusUpstream = statusUpstreamObservation
export const checkUpstream = checkUpstreamObservation

export interface ConnectGitUpstreamOptions {
  readonly database?: string
  readonly name?: string
  readonly description?: string
  readonly ref?: string
  readonly roots?: readonly string[]
  readonly include?: readonly string[]
  readonly exclude?: readonly string[]
  readonly operationId?: string
}

/** Human input for the common Git connection; discovery and publication remain core-owned. */
export function connectGitUpstream(source: string, options: ConnectGitUpstreamOptions = {}) {
  return Effect.gen(function* () {
    const path = yield* Path.Path
    const selected = yield* Effect.try({
      try: () => {
        let url = source
        let ref = options.ref ?? "HEAD"
        let root = "."
        if (/^https?:\/\//.test(source)) {
          const parsed = new URL(source)
          if (parsed.hostname === "github.com") {
            const parts = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent)
            if (parts[2] === "tree") {
              const requested = options.ref?.split("/") ?? [parts[3]!]
              if (
                !requested.length ||
                requested.some((part, index) => !part || part !== parts[3 + index])
              )
                throw fail(
                  "INVALID_ARGUMENT",
                  "A GitHub tree URL must match --ref; use a repository URL with --root for another ref.",
                )
              ref = requested.join("/")
              root = parts.slice(3 + requested.length).join("/") || "."
            } else if (parts.length !== 2)
              throw fail("INVALID_ARGUMENT", "Use a GitHub repository or tree URL.")
            parsed.pathname = `/${parts[0]}/${parts[1]!.replace(/\.git$/, "")}.git`
            url = parsed.href
          }
        } else if (/^(?:\/|\.\.?\/)/.test(source)) url = path.resolve(source)
        validateGitSource(url, ref)
        const label =
          url
            .replace(/\/$/, "")
            .split(/[/:]/)
            .at(-1)!
            .replace(/\.git$/, "") || "Upstream Skills"
        const name = options.name ?? label
        const description = options.description ?? `Skills synchronized from ${name}.`
        validateDisplayName(name)
        validateDescription(description)
        const selection = {
          roots: [...new Set(options.roots ?? [root])],
          include: [...new Set(options.include ?? [])],
          exclude: [...new Set(options.exclude ?? [])],
          mapping: {},
        }
        validateSourceSelection(selection)
        return {
          name,
          description,
          source: { provider: { type: "git" as const, url, ref } },
          ...selection,
        }
      },
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail("INVALID_ARGUMENT", "Invalid Git source connection."),
    })
    const database = yield* creationSource(options.database)
    return yield* connectUpstream(
      {
        ...selected,
        target_database_id: database.database_id,
        default_context: false,
        enabled: true,
      },
      { operationId: options.operationId },
    )
  })
}

function connectionIdentity(input: SubscriptionInput) {
  const { accepted_ref: _accepted, ...source } = input.source
  return canonical({
    target_database_id: input.target_database_id,
    source,
    roots: [...new Set(input.roots)].sort(),
    include: [...new Set(input.include)].sort(),
    exclude: [...new Set(input.exclude)].sort(),
    mapping: input.mapping,
  })
}

/** Reuse structural identity and the original add receipt, then perform the ordinary run. */
export function connectUpstream(
  input: SubscriptionInput,
  options: { readonly operationId?: string } = {},
) {
  return Effect.gen(function* () {
    const requested = yield* Effect.try({
      try: () => strictDecode(SubscriptionInputSchema, input),
      catch: (error) => error as SkillsError,
    })
    const scope = yield* authScope
    const database = yield* subscriptionDatabase
    const identity = connectionIdentity(requested)
    const operationId =
      options.operationId ??
      `ua_connect_${yield* sha256(canonical([scope, database.database_id, identity]))}`
    const store = yield* Store
    return yield* withLocalLocks(
      store.root,
      [`upstream-connect:${operationId}`],
      Effect.gen(function* () {
        const state = yield* UpstreamState
        const prior = yield* state.command(operationId)
        let subscription
        let reused = prior !== undefined
        if (prior !== undefined) {
          const evidence = property(prior)
          if (
            evidence.domain !== "subscription_add" ||
            evidence.scope !== scope ||
            evidence.database_id !== database.database_id
          )
            return yield* Effect.fail(
              fail(
                "UPSTREAM_OPERATION_MISMATCH",
                "The connection receipt belongs to another operation or authentication scope.",
                { operation_id: operationId },
              ),
            )
          const original = yield* Effect.try({
            try: () => strictDecode(SubscriptionInputSchema, evidence.input),
            catch: (error) => error as SkillsError,
          })
          if (connectionIdentity(original) !== identity)
            return yield* Effect.fail(
              fail(
                "UPSTREAM_OPERATION_MISMATCH",
                "The connection receipt belongs to another frozen source connection.",
                { operation_id: operationId },
              ),
            )
          // Display defaults initialize a connection; retries recover the original frozen add.
          subscription = yield* addSubscription(original, operationId)
          if (connectionIdentity(subscription) !== identity)
            return yield* Effect.fail(
              fail(
                "UPSTREAM_OPERATION_MISMATCH",
                "The existing subscription configuration changed; select or update that exact subscription.",
                { operation_id: operationId, subscription_id: subscription.subscription_id },
              ),
            )
        } else {
          const matches = (yield* listSubscriptions).filter(
            (candidate) => !candidate.removed && connectionIdentity(candidate) === identity,
          )
          if (matches.length > 1)
            return yield* Effect.fail(
              fail(
                "UPSTREAM_TARGET_CONFLICT",
                "Several subscriptions already describe this source connection; select the exact subscription.",
                { subscription_ids: matches.map((candidate) => candidate.subscription_id) },
              ),
            )
          reused = matches.length === 1
          subscription = matches[0] ?? (yield* addSubscription(requested, operationId))
        }
        if (!subscription.enabled || subscription.removed)
          return yield* Effect.fail(
            fail(
              "UPSTREAM_DISABLED",
              "The existing source connection is disabled or removed; update that exact subscription before running it.",
              { subscription_id: subscription.subscription_id },
            ),
          )
        const execution = yield* executeUpstreams({ targets: [subscription.subscription_id] })
        return {
          subscription: execution.subscriptions.get(subscription.subscription_id) ?? subscription,
          reused,
          ...execution.result,
        }
      }),
    )
  })
}
